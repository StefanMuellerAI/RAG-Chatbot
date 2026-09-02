import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { errorResponse, readJson } from "@/lib/api";
import {
  Fundstellensammler,
  SYSTEM_ANWEISUNG,
  baueKatalog,
  baueKontextblock,
  baueSuchwerkzeug,
  baueSystemanweisung,
  modell,
  sucheMitSchwelle,
} from "@/lib/ai";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlungen } from "@/lib/collections";
import { ValidationError } from "@/lib/errors";
import { DEFAULT_MODEL_ID, isKnownModel, modellFuerWerkzeuge } from "@/lib/models";
import { gibFrageZurueck, pruefeFragekontingent } from "@/lib/ratelimit";
import { baueCypherWerkzeug, baueSqlWerkzeug, toStep } from "@/lib/tools";
import { verbucheFrage } from "@/lib/verbrauch";

export const runtime = "nodejs";
/**
 * 300 Sekunden statt der bisherigen 60.
 *
 * Der Vorgaenger brach bei 60 Sekunden mitten im Stream ab, und der Client
 * speicherte die halbe Antwort als vollstaendig. Mit Werkzeugaufrufen kommen
 * jetzt mehrere Modelldurchlaeufe hinzu, und bei Ueberlast wiederholt das
 * Gateway - 60 Sekunden waeren damit regelmaessig zu knapp.
 */
export const maxDuration = 300;

/** Obergrenzen fuer das, was der Client schicken darf. */
const MAX_RUNDEN = 8;
const MAX_ZEICHEN_JE_NACHRICHT = 8_000;
/**
 * Die letzte Frage enger als der uebrige Verlauf: Sie geht im Werkzeugmodus
 * in jeden Schritt erneut ein, und eine 8.000-Zeichen-Frage ist keine Frage
 * mehr, sondern ein eingefuegtes Dokument.
 */
const MAX_ZEICHEN_JE_FRAGE = 2_000;
/** Hoechstens zwei Suchen und eine Antwort. */
const MAX_SCHRITTE = 3;
/**
 * Mit SQL oder Cypher mehr Luft: Eine Abfrage kann am Schema scheitern, und
 * das Modell soll sie nach der Fehlermeldung bis zu zweimal korrigieren
 * duerfen, bevor es antwortet.
 */
const MAX_SCHRITTE_ABFRAGEN = 6;

type ClientNachricht = { role: "user" | "assistant"; content: string };

type Tokenverbrauch = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
};

export async function POST(request: Request) {
  let userId: string | null = null;
  let kontingentVerbraucht = false;

  try {
    const kontext = await requireKontext();
    userId = kontext.userId;

    const { messages } = await readJson<{ messages?: ClientNachricht[] }>(request);
    const verlauf = bereinigeVerlauf(messages);

    const frage = [...verlauf].reverse().find((n) => n.role === "user")?.content;
    if (!frage) throw new ValidationError("Es wurde keine Frage uebermittelt.");

    // Vor dem Kontingent: eine abgewiesene Frage soll nichts kosten und nichts
    // zurueckgebucht werden muessen.
    if (frage.length > MAX_ZEICHEN_JE_FRAGE) {
      return Response.json(
        {
          error:
            `Die Frage ist zu lang (hoechstens ${MAX_ZEICHEN_JE_FRAGE.toLocaleString("de-DE")} ` +
            `Zeichen). Bitte kuerzen oder in mehrere Fragen aufteilen.`,
          code: "zu_lang",
        },
        { status: 413 },
      );
    }

    // Kontingente vor jeder Arbeit. Eine abgewiesene Frage soll nichts kosten,
    // auch keine Vektorsuche.
    await pruefeFragekontingent(kontext.userId, kontext.plan.maxQuestionsPerDay);
    kontingentVerbraucht = true;

    const sammlungen = await ladeSammlungen(kontext.userId);

    if (sammlungen.length === 0) {
      await gibFrageZurueck(kontext.userId);
      return ndjsonAntwort([
        { type: "sources", sources: [] },
        {
          type: "text",
          delta:
            "Sie haben noch keine Sammlung angelegt. Unter **Sammlungen** koennen Sie eine " +
            "anlegen und Dokumente einpflegen; danach beantworte ich Fragen dazu.",
        },
        { type: "done" },
      ]);
    }

    const planModelId = isKnownModel(kontext.plan.modelId)
      ? kontext.plan.modelId
      : DEFAULT_MODEL_ID;

    const sammler = new Fundstellensammler();

    /**
     * Drei Wege:
     *
     * 1. Genau eine Dokumentensammlung: direkt suchen und den Kontext der
     *    Frage voranstellen, ohne Werkzeug. Das spart einen vollstaendigen
     *    Modelldurchlauf, und weil die meisten Nutzer mit einer Sammlung
     *    arbeiten, ist es der wirksamste einzelne Einspareffekt im ganzen
     *    Frageweg. Dieser Weg bleibt, wie er war.
     * 2. Genau eine Tabellen- oder Graph-Sammlung: Werkzeugmodus mit fest
     *    gebundener Sammlung und nur dem passenden Werkzeug.
     * 3. Mehrere Sammlungen: Werkzeugmodus mit den Werkzeugen der vorhandenen
     *    Typen; das Modell waehlt anhand des Katalogs.
     */
    const direkt = sammlungen.length === 1 && sammlungen[0].kind === "vector";
    const hatAbfragen = sammlungen.some((s) => s.kind === "sql" || s.kind === "graph");

    // Im Werkzeugmodus ein Modell, das nach Werkzeugergebnissen zuverlaessig
    // antwortet (lib/models.ts). Verbucht wird das tatsaechlich genutzte.
    const modelId = direkt ? planModelId : modellFuerWerkzeuge(planModelId);

    let anweisung = SYSTEM_ANWEISUNG;
    let werkzeuge: ToolSet | undefined;
    let nachrichten: ModelMessage[];

    if (direkt) {
      const eintraege = sammler.fuegeHinzu(
        await sucheMitSchwelle(sammlungen[0], frage),
        sammlungen[0].name,
      );

      // Ohne Fundstellen wird das Modell gar nicht erst befragt: es koennte die
      // Antwort nur erfinden, und genau das soll hier nicht passieren.
      if (eintraege.length === 0) {
        await gibFrageZurueck(kontext.userId);
        return ndjsonAntwort([
          { type: "sources", sources: [] },
          {
            type: "text",
            delta:
              `Dazu finde ich nichts in "${sammlungen[0].name}". Moeglicherweise ist das ` +
              `passende Dokument noch nicht eingepflegt, oder die Frage laesst sich anders ` +
              `formulieren.`,
          },
          { type: "done" },
        ]);
      }

      nachrichten = verlauf.map((nachricht, i) =>
        i === verlauf.length - 1 && nachricht.role === "user"
          ? {
              role: "user" as const,
              content: `${baueKontextblock(eintraege)}\n\nFrage: ${nachricht.content}`,
            }
          : { role: nachricht.role, content: nachricht.content },
      );
    } else {
      anweisung = `${baueSystemanweisung(sammlungen)}\n\n${baueKatalog(sammlungen)}`;

      // Nur die Werkzeuge, fuer die es auch Sammlungen gibt. Bei genau einer
      // sql- oder graph-Sammlung binden die Fabriken sie fest (lib/tools.ts).
      werkzeuge = {};
      if (sammlungen.some((s) => s.kind === "vector")) {
        werkzeuge.dokumente_durchsuchen = baueSuchwerkzeug(kontext.userId, sammler);
      }
      if (sammlungen.some((s) => s.kind === "sql")) {
        werkzeuge.sql_ausfuehren = baueSqlWerkzeug(kontext.userId, sammlungen);
      }
      if (sammlungen.some((s) => s.kind === "graph")) {
        werkzeuge.cypher_ausfuehren = baueCypherWerkzeug(sammlungen);
      }

      nachrichten = verlauf.map((nachricht) => ({
        role: nachricht.role,
        content: nachricht.content,
      }));
    }

    const ergebnis = streamText({
      model: modell(modelId),
      // Anthropic-Prompt-Cache nur, wenn der Plan noch ein Claude-Modell
      // traegt. Gemini und OpenAI ignorieren die Marke nicht immer still.
      instructions: {
        role: "system",
        content: anweisung,
        ...(modelId.startsWith("anthropic/")
          ? {
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            }
          : {}),
      },
      messages: nachrichten,
      tools: werkzeuge,
      /**
       * Im ersten Schritt MUSS ein Werkzeug gerufen werden.
       *
       * Ohne diesen Zwang koennte das Modell die Frage direkt beantworten, ohne
       * ein einziges Dokument oder eine Zeile gesehen zu haben. Es entstuende
       * eine Antwort ohne Fundstellen — also genau das, was diese Anwendung
       * nicht liefern soll. Die Systemanweisung sagt es auch, aber eine
       * Anweisung ist eine Bitte und keine Schranke.
       *
       * "required" statt eines festen Namens: Welches Werkzeug passt, haengt
       * vom Sammlungstyp ab, und das entscheidet das Modell anhand des
       * Katalogs. Nur im ersten Schritt: Danach soll es entscheiden koennen,
       * ob es mit dem Gefundenen antwortet oder noch einmal nachfasst.
       */
      prepareStep: werkzeuge
        ? ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "required" as const } : {})
        : undefined,
      stopWhen: isStepCount(hatAbfragen ? MAX_SCHRITTE_ABFRAGEN : MAX_SCHRITTE),
      // Schliesst der Nutzer den Tab, wird die Erzeugung abgebrochen statt bis
      // zum Ende bezahlt.
      abortSignal: request.signal,
    });

    const encoder = new TextEncoder();

    /**
     * Eigenes NDJSON-Protokoll statt des UI-Message-Formats des SDK, weil die
     * Oberflaeche die Fundstellen und Werkzeugaufrufe als eigene Ereignisse
     * braucht: Sie stehen unter der Antwort in einklappbaren Bloecken und sind
     * kein Teil des Antworttextes.
     */
    const strom = new ReadableStream<Uint8Array>({
      async start(controller) {
        let offen = true;
        let bereitsGesendet = 0;
        let textGesehen = false;
        let schritte = 0;
        let fehlerGesehen = false;

        const sende = (ereignis: unknown) => {
          if (!offen) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(ereignis)}\n`));
          } catch {
            // Der Empfaenger ist weg. Weiterschreiben wuerde nur werfen.
            offen = false;
          }
        };

        try {
          for await (const teil of ergebnis.stream) {
            if (teil.type === "text-delta") {
              if (teil.text.trim()) textGesehen = true;
              sende({ type: "text", delta: teil.text });
              continue;
            }

            if (teil.type === "tool-result") {
              schritte += 1;

              // Nach jedem Werkzeugergebnis stehen neue Fundstellen bereit. Sie
              // gehen sofort raus, damit die Oberflaeche schon waehrend der
              // laufenden Antwort zeigen kann, worauf diese sich stuetzt.
              if (sammler.alle.length > bereitsGesendet) {
                bereitsGesendet = sammler.alle.length;
                sende({ type: "sources", sources: sammler.alle });
              }

              const step = toStep(sammlungen, teil.toolName, teil.input, teil.output);
              if (step) sende({ type: "step", step });
              continue;
            }

            if (teil.type === "tool-error") {
              schritte += 1;
              const step = toStep(sammlungen, teil.toolName, teil.input, undefined, teil.error);
              if (step) sende({ type: "step", step });
              continue;
            }

            if (teil.type === "error") {
              fehlerGesehen = true;
              sende({ type: "error", message: lesbarerFehler(teil.error) });
            }
          }

          let verbrauch: Tokenverbrauch = await ergebnis.usage;

          /**
           * Leerer Abschlusstext.
           *
           * Manche Modelle — dokumentiert fuer Gemini 2.5 Flash Lite
           * (vercel/ai#13017), beobachtet auch bei anderen — beenden den Lauf
           * nach einem Werkzeugergebnis ohne ein Wort Antwort. Dasselbe passiert,
           * wenn die Schrittgrenze mitten in den Abfragen erreicht wird. Dann
           * folgt ein weiterer Aufruf mit dem bisherigen Verlauf samt aller
           * Werkzeugaufrufe und -ergebnisse (`responseMessages` des SDK) und
           * der Bitte, sie zusammenzufassen. Werkzeuge bleiben deklariert, damit
           * die Aufrufe im Verlauf fuer den Anbieter gueltig sind, duerfen aber
           * nicht mehr gerufen werden.
           */
          if (werkzeuge && !textGesehen && schritte > 0 && !fehlerGesehen && offen) {
            const nachtrag = streamText({
              model: modell(modelId),
              instructions: anweisung,
              messages: [
                ...nachrichten,
                ...(await ergebnis.responseMessages),
                {
                  role: "user",
                  content:
                    "Fasse die Werkzeugergebnisse jetzt in einer Antwort auf die Frage zusammen. " +
                    "Rufe keine Werkzeuge mehr auf.",
                },
              ],
              tools: werkzeuge,
              toolChoice: "none",
              abortSignal: request.signal,
            });

            for await (const teil of nachtrag.stream) {
              if (teil.type === "text-delta") {
                sende({ type: "text", delta: teil.text });
              } else if (teil.type === "error") {
                sende({ type: "error", message: lesbarerFehler(teil.error) });
              }
            }

            verbrauch = summiereVerbrauch(verbrauch, await nachtrag.usage);
          }

          // Auf dem Weg ohne Werkzeug gibt es kein tool-result; die Fundstellen
          // stehen dort von Anfang an fest.
          if (bereitsGesendet === 0 && sammler.alle.length > 0) {
            sende({ type: "sources", sources: sammler.alle });
          }

          sende({ type: "done" });

          // Erst nach dem Ende verbuchen: vorher steht die Tokenzahl nicht fest.
          await verbucheFrage(kontext.userId, modelId, verbrauch);
        } catch (error) {
          sende({ type: "error", message: lesbarerFehler(error) });
        } finally {
          offen = false;
          try {
            controller.close();
          } catch {
            // Bereits geschlossen, weil der Empfaenger abgebrochen hat.
          }
        }
      },
    });

    return new Response(strom, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    // Kam keine Antwort zustande, wandert die Frage ins Kontingent zurueck.
    if (userId && kontingentVerbraucht) await gibFrageZurueck(userId);
    // Die Nutzer-ID mitgeben: Abweisungen sollen einem Konto zuzuordnen sein.
    return errorResponse(error, userId ?? undefined);
  }
}

/**
 * Verlauf bereinigen und begrenzen.
 *
 * Der Vorgaenger nahm den Verlauf ungeprueft an; die einzige Grenze war das
 * 4,5-MB-Limit fuer Request-Bodies. Ein einzelner Aufrufer konnte damit
 * Anfragen mit sechsstelliger Tokenzahl stellen und in Minuten das Monatsbudget
 * des Modellanbieters aufbrauchen. Beides wird hier gekappt.
 */
function bereinigeVerlauf(messages: ClientNachricht[] | undefined): ClientNachricht[] {
  const gueltig = (messages ?? [])
    .filter(
      (nachricht) =>
        (nachricht?.role === "user" || nachricht?.role === "assistant") &&
        typeof nachricht.content === "string" &&
        nachricht.content.trim().length > 0,
    )
    .map((nachricht) => ({
      role: nachricht.role,
      content: nachricht.content.slice(0, MAX_ZEICHEN_JE_NACHRICHT),
    }));

  // Die letzten Runden sind die, auf die sich Rueckfragen beziehen. Aeltere
  // tragen zur Antwort kaum bei, kosten aber in jedem Schritt erneut Token.
  return gueltig.slice(-MAX_RUNDEN * 2);
}

/** Beide Modellaufrufe einer Frage landen in einer Verbuchung. */
function summiereVerbrauch(a: Tokenverbrauch, b: Tokenverbrauch): Tokenverbrauch {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    inputTokenDetails: {
      cacheReadTokens:
        (a.inputTokenDetails?.cacheReadTokens ?? 0) + (b.inputTokenDetails?.cacheReadTokens ?? 0),
    },
  };
}

function ndjsonAntwort(ereignisse: unknown[]): Response {
  return new Response(
    ereignisse.map((ereignis) => `${JSON.stringify(ereignis)}\n`).join(""),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function lesbarerFehler(error: unknown): string {
  const meldung = error instanceof Error ? error.message : String(error);

  if (/429|rate.?limit|too many requests/i.test(meldung)) {
    return "Der Modellanbieter ist derzeit ausgelastet. Bitte in einem Moment erneut versuchen.";
  }

  if (/abort/i.test(meldung)) {
    return "Die Antwort wurde abgebrochen.";
  }

  return meldung;
}
