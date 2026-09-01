import { isStepCount, streamText, type ModelMessage } from "ai";
import { errorResponse, readJson, requireSession } from "@/lib/api";
import { assertCollectionAccess, listCollections, type Collection } from "@/lib/collections";
import {
  REASONING,
  SYSTEM_PROMPT,
  buildContext,
  buildToolPrompt,
  describeProviderError,
  getModel,
} from "@/lib/llm";
import {
  budgetExhausted,
  consumeDailyBudget,
  enforceLimits,
  tooManyRequests,
} from "@/lib/ratelimit";
import { resolveSettings, type ResolvedSettings } from "@/lib/settings";
import { buildTools, toStep, type ToolContext } from "@/lib/tools";
import { search, type Hit } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Treffer unterhalb dieser Aehnlichkeit sind erfahrungsgemaess Rauschen. */
const MIN_SCORE = 0.35;
const TOP_K = 8;

/** Eingabegrenzen — begrenzen Kosten pro Anfrage und halten den Prompt stabil. */
const MAX_QUESTION_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY = 10;

/** Wie viele Werkzeugrunden das Modell hoechstens drehen darf. */
const MAX_TOOL_STEPS = 6;

/** Kennung fuer "alle meine Sammlungen" im Request. */
const ALLE = "all";

type ClientMessage = { role: "user" | "assistant"; content: string };

type Source = { n: number; filename: string; location: string | null; score: number; snippet: string };

export async function POST(request: Request) {
  const { messages, collectionId } = await readJson<{ messages: unknown; collectionId: unknown }>(request);

  // Sitzung, Rate-Limit pro Nutzer und Zugriff auf die Sammlung(en) — alles
  // vor jeglicher Arbeit, die Geld kostet.
  let session;
  let collections: Collection[];
  let einzelne: Collection | undefined;
  try {
    session = await requireSession();
    const limit = await enforceLimits(session.userId, ["chat-minute", "chat-hour"]);
    if (!limit.ok) return tooManyRequests(limit);

    if (collectionId === ALLE) {
      collections = await listCollections(session.userId);
      if (collections.length === 0) {
        return Response.json({ error: "Es gibt noch keine Sammlung, die befragt werden koennte." }, { status: 400 });
      }
    } else {
      einzelne = await assertCollectionAccess(collectionId, session);
      collections = [einzelne];
    }
  } catch (error) {
    return errorResponse(error);
  }

  const history = (Array.isArray(messages) ? (messages as unknown[]) : [])
    .filter(istNachricht)
    .map((message) => ({ ...message, content: message.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY);

  const question = [...history].reverse().find((message) => message.role === "user")?.content;
  if (!question) {
    return Response.json({ error: "Es wurde keine Frage uebermittelt." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json(
      { error: `Die Frage ist zu lang (maximal ${MAX_QUESTION_CHARS.toLocaleString("de-DE")} Zeichen).` },
      { status: 413 },
    );
  }

  let settings;
  try {
    settings = await resolveSettings();
  } catch (error) {
    return errorResponse(error);
  }

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const gemeinsam = { request, abort, session, settings, history };

  return einzelne?.kind === "vector"
    ? vektorEinzelmodus({ ...gemeinsam, collection: einzelne, question })
    : werkzeugmodus({ ...gemeinsam, collections, einzelne });
}

type Gemeinsam = {
  request: Request;
  abort: AbortController;
  session: { userId: string };
  settings: ResolvedSettings;
  history: ClientMessage[];
};

/**
 * Der klassische Ablauf fuer eine einzelne Dokumentensammlung: erst suchen,
 * ohne Treffer kein Modellaufruf, sonst Kontext in die Frage einbetten.
 */
async function vektorEinzelmodus({
  abort,
  session,
  settings,
  history,
  collection,
  question,
}: Gemeinsam & { collection: Collection; question: string }): Promise<Response> {
  let hits: Hit[];
  try {
    hits = (await search(collection.namespace, question, TOP_K)).filter((hit) => hit.score >= MIN_SCORE);
  } catch (error) {
    return errorResponse(error);
  }

  // Ohne Fundstellen wird das Modell gar nicht erst befragt: es koennte die
  // Antwort nur erfinden, und genau das soll hier nicht passieren.
  if (hits.length === 0) {
    return ndjsonResponse([
      { type: "sources", sources: [] },
      {
        type: "text",
        delta:
          "Dazu finde ich nichts in der hinterlegten Dokumentensammlung. " +
          "Moeglicherweise ist das passende Dokument noch nicht eingepflegt, " +
          "oder die Frage laesst sich anders formulieren.",
      },
      { type: "done" },
    ]);
  }

  const budget = await reserviereBudget(settings, session.userId);
  if (budget) return budget;

  const apiMessages: ModelMessage[] = history.map((message, i) =>
    i === history.length - 1 && message.role === "user"
      ? { role: "user", content: `${buildContext(hits)}\n\nFrage: ${message.content}` }
      : { role: message.role, content: message.content },
  );

  const result = streamText({
    model: getModel(settings),
    instructions: SYSTEM_PROMPT,
    messages: apiMessages,
    maxOutputTokens: 4096,
    reasoning: REASONING,
    abortSignal: abort.signal,
    onError: ({ error }) => {
      if (!abort.signal.aborted) console.error("Modellaufruf fehlgeschlagen:", error);
    },
  });

  return streamAntwort({
    abort,
    settings,
    stream: result.stream,
    vorab: [{ type: "sources", sources: alsQuellen(hits, 0) }],
  });
}

/**
 * Werkzeugmodus: fuer Tabellen- und Graph-Sammlungen sowie "alle Sammlungen".
 * Das Modell entscheidet, welche Werkzeuge es aufruft; jeder Aufruf wird als
 * `step`-Ereignis an den Browser gemeldet.
 */
async function werkzeugmodus({
  abort,
  session,
  settings,
  history,
  collections,
  einzelne,
}: Gemeinsam & { collections: Collection[]; einzelne: Collection | undefined }): Promise<Response> {
  const budget = await reserviereBudget(settings, session.userId);
  if (budget) return budget;

  const gesammelt: Source[] = [];
  const context: ToolContext = {
    collections,
    fixed: einzelne,
    onHits: (hits) => gesammelt.push(...alsQuellen(hits, gesammelt.length)),
  };

  const apiMessages: ModelMessage[] = history.map((message) => ({ role: message.role, content: message.content }));

  const result = streamText({
    model: getModel(settings),
    instructions: buildToolPrompt(collections, einzelne !== undefined),
    messages: apiMessages,
    tools: buildTools(context),
    stopWhen: isStepCount(MAX_TOOL_STEPS),
    maxOutputTokens: 4096,
    reasoning: REASONING,
    abortSignal: abort.signal,
    onError: ({ error }) => {
      if (!abort.signal.aborted) console.error("Modellaufruf fehlgeschlagen:", error);
    },
  });

  return streamAntwort({
    abort,
    settings,
    stream: result.stream,
    context,
    nachher: () => [{ type: "sources", sources: gesammelt }],
  });
}

async function reserviereBudget(settings: ResolvedSettings, userId: string): Promise<Response | null> {
  try {
    const budget = await consumeDailyBudget({
      globalLimit: settings.dailyAnswerLimit,
      userId,
      userLimit: settings.dailyAnswerLimitPerUser,
    });
    return budget.ok ? null : budgetExhausted(budget);
  } catch (error) {
    return errorResponse(error);
  }
}

function alsQuellen(hits: Hit[], offset: number): Source[] {
  return hits.map((hit, i) => ({
    n: offset + i + 1,
    filename: hit.metadata.filename,
    location: hit.metadata.location ?? null,
    score: Math.round(hit.score * 1000) / 1000,
    snippet: hit.text.slice(0, 240),
  }));
}

/**
 * Uebersetzt den AI-SDK-Stream in das NDJSON-Protokoll des Browsers.
 * Bricht der Browser die Verbindung ab, wird auch die Anfrage an den Anbieter
 * beendet — sonst liefe die Generierung samt Abrechnung im Hintergrund weiter.
 */
function streamAntwort({
  abort,
  settings,
  stream: teile,
  context,
  vorab = [],
  nachher,
}: {
  abort: AbortController;
  settings: ResolvedSettings;
  stream: AsyncIterable<{ type: string } & Record<string, unknown>>;
  context?: ToolContext;
  vorab?: unknown[];
  nachher?: () => unknown[];
}): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        if (abort.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      vorab.forEach(send);

      try {
        // `streamText` wirft nicht, sondern liefert Fehler als Teil des Streams.
        for await (const part of teile) {
          switch (part.type) {
            case "text-delta":
              send({ type: "text", delta: part.text });
              break;
            case "tool-result":
              if (context) {
                const step = toStep(context, String(part.toolName), part.input, part.output);
                if (step) send({ type: "step", step });
              }
              break;
            case "tool-error":
              if (context) {
                const step = toStep(context, String(part.toolName), part.input, undefined, part.error);
                if (step) send({ type: "step", step });
              }
              break;
            case "error":
              send({ type: "error", message: describeProviderError(part.error, settings.provider) });
              break;
          }
        }
        nachher?.().forEach(send);
        send({ type: "done" });
      } catch (error) {
        if (!abort.signal.aborted) {
          send({ type: "error", message: describeProviderError(error, settings.provider) });
        }
      } finally {
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

function istNachricht(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const { role, content } = value as Record<string, unknown>;
  return (
    (role === "user" || role === "assistant") &&
    typeof content === "string" &&
    content.trim().length > 0
  );
}

function ndjsonResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
