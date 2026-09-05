import { randomUUID } from "node:crypto";
import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { errorResponse, readJson } from "@/lib/api";
import { Fundstellensammler, SYSTEM_ANWEISUNG, baueKatalog, baueKontextblock, baueSuchwerkzeug, baueSystemanweisung, modell, sucheMitSchwelle } from "@/lib/ai";
import { requireKontext } from "@/lib/auth/user";
import { acquireCapacity, reserveModelCall, withCapacity } from "@/lib/capacity";
import { AnswerBudget, chatRequestSchema, tokenBound, type GenerationStatus } from "@/lib/chat-contract";
import { beginGeneration, existingRun, generationContext, saveGeneration } from "@/lib/chat-generation";
import { ladeSammlungen } from "@/lib/collections";
import { RateLimitError, ToolUnavailableError, ValidationError } from "@/lib/errors";
import { MissingConfigError } from "@/lib/env";
import { findeModell } from "@/lib/modellkatalog";
import { modellFuerWerkzeuge } from "@/lib/models";
import { erwirbSperre, gibSperreFrei, gibFrageZurueck, pruefeFragekontingent } from "@/lib/ratelimit";
import { baueCypherWerkzeug, baueSqlWerkzeug, toStep, type ToolStep } from "@/lib/tools";
import { verbucheFrage } from "@/lib/verbrauch";

export const runtime = "nodejs";
export const maxDuration = 300;
const STREAM_HEADERS = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };
type Usage = { inputTokens: number; outputTokens: number; inputTokenDetails: { cacheReadTokens: number } };

export async function POST(request: Request) {
  const startedAt = Date.now();
  let unlock: (() => Promise<void>) | undefined;
  try {
    const kontext = await requireKontext();
    const parsed = chatRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new ValidationError("Bitte Chatkennung, Anfragekennung und eine Frage mit hoechstens 2.000 Zeichen uebermitteln.");
    const input = parsed.data;
    const previous = await existingRun(kontext.userId, input);
    if (previous?.run.status === "completed" && previous.answer) {
      return new Response([
        { type: "start", requestId: input.requestId, userMessageId: previous.run.userMessageId, assistantMessageId: previous.run.assistantMessageId },
        { type: "sources", sources: previous.answer.sources ?? [] },
        ...(previous.answer.steps ?? []).map(step => ({ type: "step", step })),
        { type: "text", delta: previous.answer.content },
        { type: "done", status: "completed", modelInvoked: false, replayed: true },
      ].map(event => JSON.stringify(event) + "\n").join(""), { headers: STREAM_HEADERS });
    }
    const lockKey = `wa:chat:${kontext.userId}:${input.chatId}`;
    const owner = randomUUID();
    if (!await erwirbSperre(lockKey, owner, 300)) {
      return Response.json({ error: "In diesem Chat wird bereits eine Antwort erstellt.", code: "bereits_aktiv", retryAfter: 3 }, { status: 409, headers: { "Retry-After": "3" } });
    }
    unlock = () => gibSperreFrei(lockKey, owner);
    const run = await beginGeneration(kontext.userId, input);
    // Another request may have completed between the first read and lease acquisition.
    if (run.status === "completed") {
      const saved = await existingRun(kontext.userId, input);
      await unlock();
      unlock = undefined;
      if (!saved?.answer) throw new ValidationError("Die gespeicherte Antwort ist nicht verfuegbar.");
      return new Response([
        { type: "start", requestId: input.requestId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId },
        { type: "sources", sources: saved.answer.sources ?? [] },
        ...(saved.answer.steps ?? []).map(step => ({ type: "step", step })),
        { type: "text", delta: saved.answer.content },
        { type: "done", status: "completed", modelInvoked: false, replayed: true },
      ].map(event => JSON.stringify(event) + "\n").join(""), { headers: STREAM_HEADERS });
    }
    const releaseChat = unlock;
    const cancellation = new AbortController();
    const deadline = AbortSignal.timeout(240_000);
    const signal = AbortSignal.any([request.signal, cancellation.signal, deadline]);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancellation.abort(); },
      async start(controller) {
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
        let releaseCapacity: (() => Promise<void>) | undefined;
        let lastSaved = Date.now();
        let firstTokenMs: number | null = null;
        const timings: Record<string, number> = {};
        const usage: Usage = { inputTokens: 0, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } };
        const send = (event: unknown) => {
          if (!connected) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
          catch { connected = false; cancellation.abort(); }
        };
        const phase = (phase: string, message: string) => {
          timings[phase] ??= Date.now() - startedAt;
          send({ type: "status", phase, message });
        };
        const persist = async (final = false) => {
          if (!final && Date.now() - lastSaved < 2000) return;
          await saveGeneration(run, { content, sources: sammler.alle, steps, status });
          lastSaved = Date.now();
        };
        const text = (delta: string) => {
          if (firstTokenMs === null && delta.trim()) firstTokenMs = Date.now() - startedAt;
          content += delta;
          send({ type: "text", delta });
        };
        send({ type: "start", requestId: input.requestId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId });
        phase("queued", "Anfrage wird vorbereitet …");
        try {
          signal.throwIfAborted();
          const [allCollections, planModel, history] = await Promise.all([
            ladeSammlungen(kontext.userId), findeModell(kontext.plan.modelId), generationContext(kontext.userId, input),
          ]);
          const selected = input.collectionIds?.length ? new Set(input.collectionIds) : null;
          if (selected && [...selected].some(id => !allCollections.some(s => s.id === id))) throw new ValidationError("Eine ausgewaehlte Sammlung ist nicht verfuegbar.");
          const sammlungen = selected ? allCollections.filter(s => selected.has(s.id)) : allCollections;
          await pruefeFragekontingent(kontext.userId, kontext.plan.maxQuestionsPerDay);
          quota = true;
          const admissionStarted = Date.now();
          releaseCapacity = await acquireCapacity("chat", { signal, onWait: () => phase("queued", "Warte auf freie Antwortkapazitaet …") });
          chatAdmissionMs = Date.now() - admissionStarted;
          if (!sammlungen.length) {
            text("Sie haben noch keine Sammlung angelegt. Unter **Sammlungen** koennen Sie Dateien einpflegen und anschliessend Fragen stellen.");
          } else {
            const direct = sammlungen.length === 1 && sammlungen[0].kind === "vector";
            const hasQueries = sammlungen.some(s => s.kind !== "vector");
            modelId = direct ? planModel.id : modellFuerWerkzeuge(planModel.id);
            const budget = new AnswerBudget(input.detail);
            let instructions = direct ? SYSTEM_ANWEISUNG : `${baueSystemanweisung(sammlungen)}\n\n${baueKatalog(sammlungen)}`;
            instructions += input.detail === "detailed" ? "\nErklaere die Antwort ausfuehrlich, soweit die Quellen das erlauben." : "\nAntworte kompakt. Beginne mit dem Ergebnis und nenne dann nur die wesentlichen Belege.";
            let modelMessages: ModelMessage[] = history;
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
              } else modelMessages = [...history.slice(0, -1), { role: "user", content: `${baueKontextblock(entries)}\n\nFrage: ${input.question}` }];
            } else {
              tools = {};
              if (sammlungen.some(s => s.kind === "vector")) tools.dokumente_durchsuchen = baueSuchwerkzeug(kontext.userId, sammler, { sammlungen, signal, onStatus: phase });
              if (sammlungen.some(s => s.kind === "sql")) tools.sql_ausfuehren = baueSqlWerkzeug(kontext.userId, sammlungen, { signal, onStatus: phase });
              if (sammlungen.some(s => s.kind === "graph")) tools.cypher_ausfuehren = baueCypherWerkzeug(sammlungen, { signal, onStatus: phase });
            }
            if (found) {
              const languageModel = await modell(modelId);
              const createResult = (messages: ModelMessage[], final = false) => streamText({
                model: languageModel, instructions, messages, tools,
                maxRetries: 0, maxOutputTokens: budget.maxStepOutput, abortSignal: signal,
                stopWhen: isStepCount(final ? 1 : hasQueries ? 6 : 3),
                prepareStep: async ({ stepNumber, messages, instructions }) => {
                  signal.throwIfAborted();
                  const inputBound = tokenBound(messages) + tokenBound(instructions ?? "") + (tools ? 4096 : 512);
                  const maxOutputTokens = budget.reserve(inputBound);
                  const modelAdmissionStarted = Date.now();
                  await reserveModelCall(modelId, inputBound + maxOutputTokens, { signal, onWait: () => phase("queued", "Warte auf freie Modellkapazitaet …") });
                  modelAdmissionMs += Date.now() - modelAdmissionStarted;
                  modelInvoked = true;
                  modelCallsStarted += 1;
                  phase("generating", tools && !final && stepNumber === 0 ? "Passende Datenquelle wird ausgewaehlt …" : "Antwort wird formuliert …");
                  return { maxOutputTokens, ...(final ? { toolChoice: "none" as const } : tools && stepNumber === 0 ? { toolChoice: "required" as const } : {}) };
                },
                onStepEnd: ({ usage: stepUsage }) => {
                  if (typeof stepUsage.inputTokens === "number" && typeof stepUsage.outputTokens === "number") modelCallsMetered += 1;
                  usage.inputTokens += stepUsage.inputTokens ?? 0;
                  usage.outputTokens += stepUsage.outputTokens ?? 0;
                  usage.inputTokenDetails.cacheReadTokens += stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
                  budget.output += stepUsage.outputTokens ?? 0;
                },
              });
              const consume = async (result: ReturnType<typeof createResult>) => {
                for await (const part of result.stream) {
                  signal.throwIfAborted();
                  if (part.type === "text-delta") { text(part.text); await persist(); }
                  else if (part.type === "error") throw part.error;
                  else if (part.type === "tool-result" || part.type === "tool-error") {
                    // The SDK turns a rejected execute() into tool-error. Overload
                    // must still end the run, not trigger more model/tool attempts.
                    if (part.type === "tool-error" && (part.error instanceof RateLimitError
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
              if (!content.trim() && tools && steps.length) {
                await consume(createResult([...modelMessages, ...await result.responseMessages,
                  { role: "user", content: "Beantworte die Frage jetzt anhand der Werkzeugergebnisse. Keine weiteren Werkzeuge." }], true));
              }
              if (!content.trim()) throw new Error("Das Modell hat keine Antwort geliefert.");
            }
          }
          signal.throwIfAborted();
          status = "completed";
        } catch (error) {
          status = signal.aborted && !deadline.aborted ? "aborted" : "failed";
          const message = status === "aborted" ? "Die Antwort wurde gestoppt und ist unvollstaendig." : readableError(error, deadline.aborted);
          if (!content) content = message;
          send({ type: "error", message, code: status, ...(error instanceof RateLimitError ? { retryAfter: error.retryAfterSeconds } : {}) });
        } finally {
          try { phase("saving", "Antwort wird gespeichert …"); await persist(true); }
          catch {
            status = "failed";
            send({ type: "error", code: "speichern", message: "Die Antwort konnte nicht gespeichert werden. Bitte kopieren Sie den Text und laden Sie den Verlauf erneut." });
          }
          if (quota && (!modelInvoked || usage.outputTokens === 0 && status !== "completed")) await gibFrageZurueck(kontext.userId).catch(() => console.error("Kontingentrueckgabe fehlgeschlagen", { requestId: run.id }));
          if (modelInvoked) await verbucheFrage(kontext.userId, modelId, usage).catch(() => console.error("Verbrauchsbuchung fehlgeschlagen", { requestId: run.id }));
          await releaseCapacity?.().catch(() => undefined);
          await releaseChat().catch(() => console.error("Chatfreigabe fehlgeschlagen", { requestId: run.id }));
          const usageComplete = modelCallsStarted === modelCallsMetered;
          console.log(JSON.stringify({ event: "chat_run", requestId: run.id, attempt: run.attempt, status, model: modelId, modelInvoked,
            firstTokenMs, durationMs: Date.now() - startedAt, chatAdmissionMs, modelAdmissionMs, phases: timings,
            steps: steps.length, modelCallsStarted, usage, usageComplete }));
          send({ type: "done", status, modelInvoked, usage, usageComplete });
          connected = false;
          try { controller.close(); } catch { /* disconnected */ }
        }
      },
    });
    unlock = undefined;
    return new Response(stream, { headers: STREAM_HEADERS });
  } catch (error) {
    await unlock?.().catch(() => undefined);
    return errorResponse(error);
  }
}

function readableError(error: unknown, timedOut: boolean): string {
  if (timedOut) return "Die Antwort hat zu lange gedauert und wurde beendet. Bitte die Frage eingrenzen oder erneut versuchen.";
  if (error instanceof RateLimitError || error instanceof ValidationError) return error.message;
  if (error instanceof ToolUnavailableError) return "Der Abfragedienst ist derzeit nicht verfuegbar. Bitte in einem Moment erneut versuchen.";
  if (error instanceof MissingConfigError) return "Ein benoetigter Dienst ist noch nicht eingerichtet. Bitte die Administration informieren.";
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 429) return "Der Modellanbieter ist ausgelastet. Bitte in einem Moment erneut versuchen.";
  if (status === 401 || status === 403 || status === 404) return "Das eingestellte Modell ist derzeit nicht verfuegbar. Bitte die Administration informieren.";
  return "Die Antwort konnte nicht abgeschlossen werden. Bitte erneut versuchen.";
}
