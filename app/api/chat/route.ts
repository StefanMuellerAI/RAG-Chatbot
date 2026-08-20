import { isStepCount, streamText, type ModelMessage } from "ai";
import { errorResponse, readJson } from "@/lib/api";
import {
  Fundstellensammler,
  SYSTEM_ANWEISUNG,
  baueKatalog,
  baueKontextblock,
  baueSuchwerkzeug,
  modell,
  sucheMitSchwelle,
} from "@/lib/ai";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlungen } from "@/lib/collections";
import { ValidationError } from "@/lib/errors";
import { DEFAULT_MODEL_ID, isKnownModel } from "@/lib/models";
import { gibFrageZurueck, pruefeFragekontingent } from "@/lib/ratelimit";
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
/** Hoechstens zwei Suchen und eine Antwort. */
const MAX_SCHRITTE = 3;

type ClientNachricht = { role: "user" | "assistant"; content: string };

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

    const modelId = isKnownModel(kontext.plan.modelId)
      ? kontext.plan.modelId
      : DEFAULT_MODEL_ID;

    const sammler = new Fundstellensammler();

    /**
     * Bei genau einer Sammlung gibt es nichts auszuwaehlen: direkt suchen und
     * den Kontext der Frage voranstellen, ohne Werkzeug. Das spart einen
     * vollstaendigen Modelldurchlauf, und weil die meisten Nutzer mit einer
     * Sammlung arbeiten, ist es der wirksamste einzelne Einspareffekt im
     * ganzen Frageweg.
     */
    const einzeln = sammlungen.length === 1;
    let anweisung = SYSTEM_ANWEISUNG;
    let werkzeuge: Record<string, ReturnType<typeof baueSuchwerkzeug>> | undefined;
    let nachrichten: ModelMessage[];

    if (einzeln) {
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
      anweisung = `${SYSTEM_ANWEISUNG}\n\n${baueKatalog(sammlungen)}`;
      werkzeuge = { dokumente_durchsuchen: baueSuchwerkzeug(kontext.userId, sammler) };
      nachrichten = verlauf.map((nachricht) => ({
        role: nachricht.role,
        content: nachricht.content,
      }));
    }

    const ergebnis = streamText({
      model: modell(modelId),
      // Systemanweisung und Sammlungskatalog aendern sich zwischen den Fragen
      // eines Nutzers nicht. Als Cache-Marke gekennzeichnet zaehlen sie nicht
      // gegen das Minutenlimit des Anbieters und kosten ein Zehntel - bei
      // mehrstufigen Werkzeugaufrufen, die den Prompt jedes Mal erneut senden,
      // ist das der Unterschied zwischen tragbar und nicht tragbar.
      instructions: {
        role: "system",
        content: anweisung,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      messages: nachrichten,
      tools: werkzeuge,
      /**
       * Im ersten Schritt MUSS gesucht werden.
       *
       * Ohne diesen Zwang koennte das Modell die Frage direkt beantworten, ohne
       * ein einziges Dokument gesehen zu haben. Es entstuende eine Antwort ohne
       * Fundstellen — also genau das, was diese Anwendung nicht liefern soll.
       * Die Systemanweisung sagt es auch, aber eine Anweisung ist eine Bitte
       * und keine Schranke.
       *
       * Nur im ersten Schritt: Danach soll das Modell entscheiden koennen, ob
       * es mit dem Gefundenen antwortet oder noch einmal anders sucht.
       */
      prepareStep: werkzeuge
        ? ({ stepNumber }) =>
            stepNumber === 0
              ? { toolChoice: { type: "tool" as const, toolName: "dokumente_durchsuchen" } }
              : {}
        : undefined,
      stopWhen: isStepCount(MAX_SCHRITTE),
      // Schliesst der Nutzer den Tab, wird die Erzeugung abgebrochen statt bis
      // zum Ende bezahlt.
      abortSignal: request.signal,
    });

    const encoder = new TextEncoder();

    /**
     * Eigenes NDJSON-Protokoll statt des UI-Message-Formats des SDK, weil die
     * Oberflaeche die Fundstellen als eigenes Ereignis braucht: Sie stehen
     * unter der Antwort in einer einklappbaren Liste und sind kein Teil des
     * Antworttextes.
     *
     * Die Uebersetzung steht hier und nicht in einer Hilfsfunktion, weil der
     * Teiltyp des Modellstroms von der Werkzeugmenge abhaengt und vom SDK nicht
     * als benennbarer Typ exportiert wird. An dieser Stelle kennt TypeScript
     * ihn genau und verengt in den Zweigen korrekt.
     */
    const strom = new ReadableStream<Uint8Array>({
      async start(controller) {
        let offen = true;
        let bereitsGesendet = 0;

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
              sende({ type: "text", delta: teil.text });
              continue;
            }

            // Nach jedem Werkzeugergebnis stehen neue Fundstellen bereit. Sie
            // gehen sofort raus, damit die Oberflaeche schon waehrend der
            // laufenden Antwort zeigen kann, worauf diese sich stuetzt.
            if (teil.type === "tool-result" && sammler.alle.length > bereitsGesendet) {
              bereitsGesendet = sammler.alle.length;
              sende({ type: "sources", sources: sammler.alle });
              continue;
            }

            if (teil.type === "error") {
              sende({ type: "error", message: lesbarerFehler(teil.error) });
            }
          }

          // Auf dem Weg ohne Werkzeug gibt es kein tool-result; die Fundstellen
          // stehen dort von Anfang an fest.
          if (bereitsGesendet === 0 && sammler.alle.length > 0) {
            sende({ type: "sources", sources: sammler.alle });
          }

          sende({ type: "done" });

          // Erst nach dem Ende verbuchen: vorher steht die Tokenzahl nicht fest.
          await verbucheFrage(kontext.userId, modelId, await ergebnis.usage);
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
