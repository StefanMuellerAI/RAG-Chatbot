import { randomUUID } from "node:crypto";
import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { beschreibeFehler, errorResponse, readJson } from "@/lib/api";
import {
  Fundstellensammler, SYSTEM_ANWEISUNG, baueKatalog, baueKontextblock, baueSuchwerkzeug,
  baueSystemanweisung, modell, sucheMitSchwelle,
} from "@/lib/ai";
import { requireKontext, type Kontext } from "@/lib/auth/user";
import { acquireCapacity, reserveModelCall, withCapacity, type CapacityLease } from "@/lib/capacity";
import { AnswerBudget, chatRequestSchema, tokenBound, type ChatRequest, type GenerationStatus } from "@/lib/chat-contract";
import { fitAnswerMessages } from "@/lib/chat-answer-context";
import {
  existingRun, ladeVorlauf, planeGeneration, saveGeneration, schreibeGeneration,
  type ChatRun, type FruehererLauf, type Vorlauf,
} from "@/lib/chat-generation";
import { NotFoundError, QuotaError, RateLimitError, ResourceBusyError, ToolUnavailableError, ValidationError } from "@/lib/errors";
import { MissingConfigError } from "@/lib/env";
import { findeModell } from "@/lib/modellkatalog";
import { modellFuerWerkzeuge } from "@/lib/models";
import { erwirbSperre, gibSperreFrei, gibFrageZurueck, pruefeFragekontingent } from "@/lib/ratelimit";
import { baueCypherWerkzeug, baueSqlWerkzeug, toStep, type ToolStep } from "@/lib/tools";
import { verbucheFrage } from "@/lib/verbrauch";

export const runtime = "nodejs";
/**
 * 300 Sekunden: mehrere Modelldurchlaeufe mit Werkzeugen, und bei Ueberlast
 * wiederholt der Anbieter. Die Generierung selbst endet nach 240 Sekunden,
 * damit Speichern und Freigaben noch innerhalb der Frist liegen.
 */
export const maxDuration = 300;

const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
};
const SPERRE_SEKUNDEN = 300;
const GESAMTFRIST_MS = 240_000;

type Usage = { inputTokens: number; outputTokens: number; inputTokenDetails: { cacheReadTokens: number } };
/** Ein Modellaufruf im Log: Wartezeit auf das Budget, erstes Token, Dauer. */
type Modellaufruf = {
  schritt: number; art: "research" | "answer"; wartenMs: number;
  erstesTokenMs: number | null; dauerMs: number | null;
};

/**
 * Frageweg als NDJSON-Strom.
 *
 * Die Antwort geht zurueck, sobald Anmeldung und Eingabe geprueft sind; alles,
 * was Datenbank oder Redis braucht, laeuft im Strom. Der Browser sieht damit
 * vom ersten Moment an einen echten Status statt einer leeren Wartezeit.
 * Ereignisse: `status`, `start`, `sources`, `step`, `text`, `error`, `done`.
 *
 * Vor dem ersten Modellaufruf liegen drei Wartezeiten statt sechzehn:
 *
 *   1. Vorlauf lesen (ein Datenbank-Batch) und Chat-Sperre, parallel.
 *   2. Lauf schreiben, Kontingent, Zulassung und Modellkatalog, parallel.
 *   3. Modellbudget reservieren, je Aufruf.
 *
 * Ablehnungen vor dem Start (fremder Chat, laufende Antwort im selben Chat)
 * kommen als `error`-Ereignis mit `reason`, nicht mehr als HTTP-Status: Der
 * Strom ist dann schon offen.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  let kontext: Kontext;
  let input: ChatRequest;
  try {
    kontext = await requireKontext();
    const parsed = chatRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ValidationError("Bitte Chatkennung, Anfragekennung und eine Frage mit hoechstens 2.000 Zeichen uebermitteln.");
    }
    input = parsed.data;
  } catch (error) {
    return errorResponse(error);
  }

  const cancellation = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancellation.abort(); },
    start(controller) {
      return fuehreLaufAus({ controller, kontext, input, request, cancellation, startedAt });
    },
  });
  return new Response(stream, { headers: STREAM_HEADERS });
}

async function fuehreLaufAus({ controller, kontext, input, request, cancellation, startedAt }: {
  controller: ReadableStreamDefaultController<Uint8Array>; kontext: Kontext; input: ChatRequest;
  request: Request; cancellation: AbortController; startedAt: number;
}): Promise<void> {
  const deadline = AbortSignal.timeout(GESAMTFRIST_MS);
  const signal = AbortSignal.any([request.signal, cancellation.signal, deadline]);
  const encoder = new TextEncoder();
  let connected = true;
  let content = "";
  let status: GenerationStatus = "streaming";
  const sammler = new Fundstellensammler();
  const steps: ToolStep[] = [];
  let quota = false;
  let modelInvoked = false;
  let modelId = "";
  let modelCallsStarted = 0;
  let modelCallsMetered = 0;
  let chatAdmissionMs = 0;
  let modelAdmissionMs = 0;
  let preflightMs: number | null = null;
  const modellaufrufe: Modellaufruf[] = [];
  const werkzeugMs: Record<string, number> = {};
  let releaseCapacity: CapacityLease | undefined;
  let run: ChatRun | undefined;
  let geschrieben = false;
  let replayed = false;
  let lastSaved = Date.now();
  let firstTokenMs: number | null = null;
  let finishReason: string | undefined;
  /** Ablehnung vor dem Start, fuer den Client als `reason` am Fehler. */
  let ablehnung: { reason: string; retryAfter?: number } | undefined;
  const timings: Record<string, number> = {};
  const usage: Usage = { inputTokens: 0, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } };

  const lockKey = `wa:chat:${kontext.userId}:${input.chatId}`;
  const owner = randomUUID();
  let sperreGehalten = false;

  const send = (event: unknown) => {
    if (!connected) return;
    try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
    catch { connected = false; cancellation.abort(); }
  };
  const phase = (name: string, message: string) => {
    timings[name] ??= Date.now() - startedAt;
    send({ type: "status", phase: name, message });
  };
  const persist = async (final = false) => {
    if (!run || !geschrieben) return;
    if (!final && Date.now() - lastSaved < 2000) return;
    await saveGeneration(run, { content, sources: sammler.alle, steps, status });
    lastSaved = Date.now();
  };
  const text = (delta: string) => {
    if (firstTokenMs === null && delta.trim()) firstTokenMs = Date.now() - startedAt;
    content += delta;
    send({ type: "text", delta });
  };
  const sendeStart = (lauf: ChatRun) => send({
    type: "start", requestId: input.requestId,
    userMessageId: lauf.userMessageId, assistantMessageId: lauf.assistantMessageId,
  });
  /** Eine fertige, identische Anfrage wird ohne Modell wiedergegeben. */
  const wiedergeben = (frueher: FruehererLauf) => {
    sendeStart(frueher.run);
    send({ type: "sources", sources: frueher.answer?.sources ?? [] });
    for (const step of frueher.answer?.steps ?? []) send({ type: "step", step });
    send({ type: "text", delta: frueher.answer?.content ?? "" });
    replayed = true;
    status = "completed";
  };

  phase("queued", "Anfrage wird vorbereitet …");
  try {
    // 1. Vorlauf lesen und Chat-Sperre nehmen, gleichzeitig. Beide brauchen
    //    einander nicht; nur das Ergebnis beider entscheidet, wie es weitergeht.
    const sperre = erwirbSperre(lockKey, owner, SPERRE_SEKUNDEN).then((ok) => { sperreGehalten = ok; return ok; });
    let vorlauf: Vorlauf;
    try {
      vorlauf = await ladeVorlauf(kontext.userId, input);
    } catch (error) {
      await sperre.catch(() => undefined);
      throw error;
    }
    const gesperrt = await sperre;
    signal.throwIfAborted();

    if (vorlauf.previous?.run.status === "completed" && vorlauf.previous.answer) {
      wiedergeben(vorlauf.previous);
      return;
    }
    if (!gesperrt) {
      ablehnung = { reason: "bereits_aktiv", retryAfter: 3 };
      throw new ValidationError("In diesem Chat wird bereits eine Antwort erstellt.");
    }

    const selected = input.collectionIds?.length ? new Set(input.collectionIds) : null;
    if (selected && [...selected].some(id => !vorlauf.sammlungen.some(s => s.id === id))) {
      throw new ValidationError("Eine ausgewaehlte Sammlung ist nicht verfuegbar.");
    }
    const sammlungen = selected ? vorlauf.sammlungen.filter(s => selected.has(s.id)) : vorlauf.sammlungen;

    const plan = planeGeneration(kontext.userId, input, vorlauf.previous);
    run = plan.run;
    sendeStart(run);

    // 2. Schreiben, Kontingent, Zulassung und Katalog, gleichzeitig. Faellt das
    //    Kontingent durch, wird das Warten auf Zulassung sofort abgebrochen; eine
    //    trotzdem erhaltene Zulassung gibt der Abschluss wieder frei.
    const zulassungAbbruch = new AbortController();
    const zulassungSignal = AbortSignal.any([signal, zulassungAbbruch.signal]);
    const admissionStarted = Date.now();
    const [schreiben, kontingent, zulassung, katalog] = await Promise.allSettled([
      schreibeGeneration(kontext.userId, input, plan.run, plan.neu),
      pruefeFragekontingent(kontext.userId, kontext.plan.maxQuestionsPerDay)
        .catch((error: unknown) => { zulassungAbbruch.abort(); throw error; }),
      acquireCapacity("chat", { signal: zulassungSignal, onWait: () => phase("queued", "Warte auf freie Antwortkapazitaet …") }),
      findeModell(kontext.plan.modelId),
    ]);
    chatAdmissionMs = Date.now() - admissionStarted;
    if (zulassung.status === "fulfilled") releaseCapacity = zulassung.value;
    if (kontingent.status === "fulfilled") quota = true;
    if (schreiben.status === "fulfilled") geschrieben = schreiben.value;
    for (const ergebnis of [kontingent, schreiben, zulassung, katalog]) {
      if (ergebnis.status === "rejected") throw ergebnis.reason;
    }
    if (katalog.status !== "fulfilled") throw new Error("Der Modellkatalog konnte nicht gelesen werden.");

    if (!geschrieben) {
      // Zwischen Lesen und Schreiben hat ein anderer Versuch den Lauf uebernommen.
      const erneut = await existingRun(kontext.userId, input);
      if (erneut?.run.status === "completed" && erneut.answer) {
        wiedergeben(erneut);
        return;
      }
      throw new ValidationError("Diese Antwort wird bereits erstellt.");
    }
    preflightMs = Date.now() - startedAt;

    const planModel = katalog.value;
    if (!sammlungen.length) {
      text("Sie haben noch keine Sammlung angelegt. Unter **Sammlungen** koennen Sie Dateien einpflegen und anschliessend Fragen stellen.");
    } else {
      const direct = sammlungen.length === 1 && sammlungen[0].kind === "vector";
      const hasQueries = sammlungen.some(s => s.kind !== "vector");
      modelId = direct ? planModel.id : modellFuerWerkzeuge(planModel.id);
      const budget = new AnswerBudget(input.detail);
      let instructions = direct ? SYSTEM_ANWEISUNG : `${baueSystemanweisung(sammlungen)}\n\n${baueKatalog(sammlungen)}`;
      instructions += input.detail === "detailed"
        ? "\nErklaere die Antwort ausfuehrlich, soweit die Quellen das erlauben."
        : "\nAntworte kompakt in hoechstens 180 Woertern. Beginne mit dem Ergebnis und nenne dann nur die wesentlichen Belege.";
      let modelMessages: ModelMessage[] = vorlauf.history;
      let tools: ToolSet | undefined;
      let found = true;

      if (direct) {
        phase("retrieval", `Suche in „${sammlungen[0].name}“ …`);
        const hits = await withCapacity("retrieval", () => sucheMitSchwelle(sammlungen[0], input.question, signal), { signal });
        const entries = sammler.fuegeHinzu(hits, sammlungen[0].name);
        send({ type: "sources", sources: sammler.alle });
        phase("retrieval", `${entries.length} Fundstellen gefunden.`);
        if (!entries.length) {
          found = false;
          text(`Dazu finde ich keine passenden Fundstellen in „${sammlungen[0].name}“. Bitte grenzen Sie die Frage ein oder pruefen Sie die hinterlegten Dateien.`);
        } else {
          modelMessages = [...vorlauf.history.slice(0, -1), { role: "user", content: `${baueKontextblock(entries)}\n\nFrage: ${input.question}` }];
        }
      } else {
        tools = {};
        if (sammlungen.some(s => s.kind === "vector")) tools.dokumente_durchsuchen = baueSuchwerkzeug(kontext.userId, sammler, { sammlungen, signal, onStatus: phase });
        if (sammlungen.some(s => s.kind === "sql")) tools.sql_ausfuehren = baueSqlWerkzeug(kontext.userId, sammlungen, { signal, onStatus: phase });
        if (sammlungen.some(s => s.kind === "graph")) tools.cypher_ausfuehren = baueCypherWerkzeug(sammlungen, { signal, onStatus: phase });
      }

      if (found) {
        // 3. Modell aufloesen (Katalog und Key liegen im Zwischenspeicher) und generieren.
        const languageModel = await modell(modelId);
        const stepLimit = hasQueries ? 6 : 3;
        let answerStarted = false;
        const finalInstructions = `${instructions}\nBeantworte jetzt die Nutzerfrage anhand der vorhandenen Ergebnisse. Keine weiteren Werkzeuge. Benenne fehlende oder gekuerzte Belege ehrlich und schliesse die Antwort vollstaendig ab.`;

        const createResult = (messages: ModelMessage[], final = false) => {
          const answerSteps = new Set<number>();
          const aufrufStart = new Map<number, number>();
          const result = streamText({
            model: languageModel, instructions, messages, tools,
            maxRetries: 0, maxOutputTokens: budget.maxStepOutput, abortSignal: signal,
            stopWhen: isStepCount(final ? 1 : stepLimit),
            prepareStep: async ({ stepNumber, messages, instructions }) => {
              signal.throwIfAborted();
              let inputBound = tokenBound(messages) + tokenBound(instructions ?? "") + (tools ? 4096 : 512);
              const answer = final || !tools || stepNumber >= stepLimit - 1 || !budget.canResearch(inputBound);
              let answerMessages: ModelMessage[] | undefined;
              if (answer) {
                answerMessages = fitAnswerMessages(messages, budget.maxStepInput - tokenBound(finalInstructions) - 512);
                inputBound = tokenBound(answerMessages) + tokenBound(finalInstructions) + 512;
              }
              const maxOutputTokens = budget.reserve(inputBound, answer ? "answer" : "research");
              if (answer) { answerStarted = true; answerSteps.add(stepNumber); }
              const modelAdmissionStarted = Date.now();
              await reserveModelCall(modelId, inputBound + maxOutputTokens, { signal, onWait: () => phase("queued", "Warte auf freie Modellkapazitaet …") });
              const wartenMs = Date.now() - modelAdmissionStarted;
              modelAdmissionMs += wartenMs;
              modelInvoked = true;
              modelCallsStarted += 1;
              aufrufStart.set(stepNumber, Date.now());
              modellaufrufe.push({ schritt: modelCallsStarted, art: answer ? "answer" : "research", wartenMs, erstesTokenMs: null, dauerMs: null });
              phase("generating", !answer && stepNumber === 0 ? "Passende Datenquelle wird ausgewaehlt …" : "Antwort wird formuliert …");
              return { maxOutputTokens, ...(answer
                ? { toolChoice: "none" as const, activeTools: [], messages: answerMessages, instructions: finalInstructions }
                : stepNumber === 0 ? { toolChoice: "required" as const } : {}) };
            },
            onStepEnd: ({ usage: stepUsage }) => {
              if (typeof stepUsage.inputTokens === "number" && typeof stepUsage.outputTokens === "number") modelCallsMetered += 1;
              usage.inputTokens += stepUsage.inputTokens ?? 0;
              usage.outputTokens += stepUsage.outputTokens ?? 0;
              usage.inputTokenDetails.cacheReadTokens += stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
              budget.record(stepUsage.outputTokens);
            },
          });
          return { result, answerSteps, aufrufStart };
        };

        const consume = async ({ result, answerSteps, aufrufStart }: ReturnType<typeof createResult>) => {
          finishReason = undefined;
          let stepNumber = 0;
          let stepText = "";
          let calledTools = false;
          const werkzeugStart = new Map<string, number>();
          const erstesToken = () => {
            const aufruf = modellaufrufe.at(-1);
            const start = aufrufStart.get(stepNumber);
            if (aufruf && start !== undefined && aufruf.erstesTokenMs === null) aufruf.erstesTokenMs = Date.now() - start;
          };
          for await (const part of result.stream) {
            signal.throwIfAborted();
            if (part.type === "text-delta") {
              erstesToken();
              // Eine Recherche kann Vortext enthalten oder an ihrem eigenen
              // Ausgabelimit scheitern; veroeffentlicht wird nur, was ein
              // Schritt tatsaechlich als Antwort abschliesst.
              if (answerSteps.has(stepNumber)) { text(part.text); await persist(); }
              else stepText += part.text;
            } else if (part.type === "tool-call") {
              erstesToken();
              calledTools = true;
              werkzeugStart.set(part.toolCallId ?? part.toolName, Date.now());
            } else if (part.type === "finish-step") {
              finishReason = part.finishReason;
              const aufruf = modellaufrufe.at(-1);
              const start = aufrufStart.get(stepNumber);
              if (aufruf && start !== undefined) aufruf.dauerMs = Date.now() - start;
              if (!answerSteps.has(stepNumber) && finishReason === "stop" && !calledTools) text(stepText);
              stepNumber += 1;
              stepText = "";
              calledTools = false;
            } else if (part.type === "error") {
              throw part.error;
            } else if (part.type === "tool-result" || part.type === "tool-error") {
              const begonnen = werkzeugStart.get(part.toolCallId ?? part.toolName);
              if (begonnen !== undefined) werkzeugMs[part.toolName] = (werkzeugMs[part.toolName] ?? 0) + (Date.now() - begonnen);
              // Das SDK macht aus einem abgelehnten execute() ein tool-error.
              // Ueberlast muss den Lauf beenden, nicht weitere Versuche ausloesen.
              if (part.type === "tool-error" && (part.error instanceof RateLimitError || part.error instanceof ResourceBusyError
                || part.error instanceof ToolUnavailableError || part.error instanceof MissingConfigError)) throw part.error;
              const step = toStep(sammlungen, part.toolName, part.input,
                part.type === "tool-result" ? part.output : undefined,
                part.type === "tool-error" ? part.error : undefined);
              if (step) { steps.push(step); send({ type: "step", step }); }
              send({ type: "sources", sources: sammler.alle });
              await persist();
            }
          }
        };

        const result = createResult(modelMessages);
        await consume(result);
        if (tools && !answerStarted && (finishReason !== "stop" || !content.trim())) {
          await consume(createResult([...modelMessages, ...await result.result.responseMessages], true));
        }
        if (finishReason === "length") throw new ValidationError("Die Antwort ist unvollstaendig, weil das Ausgabelimit erreicht wurde.");
        if (finishReason !== "stop") throw new Error("Das Modell hat die Antwort nicht abgeschlossen.");
        if (!content.trim()) throw new Error("Das Modell hat keine Antwort geliefert.");
      }
    }
    signal.throwIfAborted();
    status = "completed";
  } catch (error) {
    status = signal.aborted && !deadline.aborted ? "aborted" : "failed";
    const message = status === "aborted" ? "Die Antwort wurde gestoppt und ist unvollstaendig." : readableError(error, deadline.aborted);
    if (!content) content = message;
    const retryAfter = error instanceof RateLimitError || error instanceof ResourceBusyError
      ? error.retryAfterSeconds : ablehnung?.retryAfter;
    send({
      type: "error", message, code: status,
      ...(ablehnung ? { reason: ablehnung.reason } : fehlergrund(error)),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  } finally {
    try {
      if (geschrieben) { phase("saving", "Antwort wird gespeichert …"); await persist(true); }
    } catch {
      status = "failed";
      send({ type: "error", code: "speichern", message: "Die Antwort konnte nicht gespeichert werden. Bitte kopieren Sie den Text und laden Sie den Verlauf erneut." });
    }
    const requestId = run?.id ?? input.requestId;
    if (quota && (!modelInvoked || usage.outputTokens === 0 && status !== "completed")) {
      await gibFrageZurueck(kontext.userId).catch(() => console.error("Kontingentrueckgabe fehlgeschlagen", { requestId }));
    }
    if (modelInvoked) await verbucheFrage(kontext.userId, modelId, usage).catch(() => console.error("Verbrauchsbuchung fehlgeschlagen", { requestId }));
    await releaseCapacity?.().catch(() => undefined);
    if (sperreGehalten) await gibSperreFrei(lockKey, owner).catch(() => console.error("Chatfreigabe fehlgeschlagen", { requestId }));
    const usageComplete = modelCallsStarted === modelCallsMetered;
    console.log(JSON.stringify({
      event: "chat_run", requestId, attempt: run?.attempt ?? null, status, replayed, model: modelId, modelInvoked,
      firstTokenMs, durationMs: Date.now() - startedAt, preflightMs, chatAdmissionMs, modelAdmissionMs, phases: timings,
      modelCalls: modellaufrufe, tools: werkzeugMs, steps: steps.length, modelCallsStarted, finishReason, usage, usageComplete,
      ...(ablehnung ? { reason: ablehnung.reason } : {}),
    }));
    send({ type: "done", status, modelInvoked, usage, usageComplete, ...(replayed ? { replayed: true } : {}) });
    connected = false;
    try { controller.close(); } catch { /* Empfaenger schon weg */ }
  }
}

/** Nur fuer bekannte Ablehnungen einen Grund nennen; Providerfehler bleiben anonym. */
function fehlergrund(error: unknown): { reason?: string } {
  const code = beschreibeFehler(error).body.code;
  return code === "nicht_gefunden" || code === "kontingent" || code === "zu_viele_anfragen" || code === "sammlung_belegt"
    ? { reason: code } : {};
}

function readableError(error: unknown, timedOut: boolean): string {
  if (timedOut) return "Die Antwort hat zu lange gedauert und wurde beendet. Bitte die Frage eingrenzen oder erneut versuchen.";
  // Eigene Fehlerklassen tragen Meldungen, die der Nutzer lesen soll: Kontingent,
  // Sperre, Eingabe, fremder Chat. Providerfehler bleiben anonym.
  if (error instanceof RateLimitError || error instanceof ResourceBusyError || error instanceof ValidationError
    || error instanceof QuotaError || error instanceof NotFoundError) return error.message;
  if (error instanceof ToolUnavailableError) return "Der Abfragedienst ist derzeit nicht verfuegbar. Bitte in einem Moment erneut versuchen.";
  if (error instanceof MissingConfigError) return "Ein benoetigter Dienst ist noch nicht eingerichtet. Bitte die Administration informieren.";
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 429) return "Der Modellanbieter ist ausgelastet. Bitte in einem Moment erneut versuchen.";
  if (status === 401 || status === 403 || status === 404) return "Das eingestellte Modell ist derzeit nicht verfuegbar. Bitte die Administration informieren.";
  return "Die Antwort konnte nicht abgeschlossen werden. Bitte erneut versuchen.";
}
