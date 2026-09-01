import { streamText, type ModelMessage } from "ai";
import { errorResponse, readJson, requireSession } from "@/lib/api";
import { assertCollectionAccess } from "@/lib/collections";
import { REASONING, SYSTEM_PROMPT, buildContext, describeProviderError, getModel } from "@/lib/llm";
import {
  budgetExhausted,
  consumeDailyBudget,
  enforceLimits,
  tooManyRequests,
} from "@/lib/ratelimit";
import { resolveSettings } from "@/lib/settings";
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

type ClientMessage = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  const { messages, collectionId } = await readJson<{ messages: unknown; collectionId: unknown }>(request);

  // Sitzung, Rate-Limit pro Nutzer und Zugriff auf die Sammlung — alles vor
  // jeglicher Arbeit, die Geld kostet.
  let session;
  let collection;
  try {
    session = await requireSession();
    const limit = await enforceLimits(session.userId, ["chat-minute", "chat-hour"]);
    if (!limit.ok) return tooManyRequests(limit);
    collection = await assertCollectionAccess(collectionId, session);
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

  // Erst jetzt zaehlt die Anfrage gegen das Tagesbudget — nur echte Modellaufrufe kosten.
  try {
    const budget = await consumeDailyBudget({
      globalLimit: settings.dailyAnswerLimit,
      userId: session.userId,
      userLimit: settings.dailyAnswerLimitPerUser,
    });
    if (!budget.ok) return budgetExhausted(budget);
  } catch (error) {
    return errorResponse(error);
  }

  const apiMessages: ModelMessage[] = history.map((message, i) =>
    i === history.length - 1 && message.role === "user"
      ? { role: "user", content: `${buildContext(hits)}\n\nFrage: ${message.content}` }
      : { role: message.role, content: message.content },
  );

  const sources = hits.map((hit, i) => ({
    n: i + 1,
    filename: hit.metadata.filename,
    location: hit.metadata.location ?? null,
    score: Math.round(hit.score * 1000) / 1000,
    snippet: hit.text.slice(0, 240),
  }));

  // Bricht der Browser die Verbindung ab (Tab geschlossen, neue Frage), wird
  // auch die Anfrage an den Anbieter beendet — sonst liefe die Generierung
  // samt Abrechnung im Hintergrund bis zum Ende weiter.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        if (abort.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      send({ type: "sources", sources });

      try {
        // `streamText` wirft nicht, sondern liefert Fehler als Teil des Streams.
        for await (const part of result.stream) {
          if (part.type === "text-delta") {
            send({ type: "text", delta: part.text });
          } else if (part.type === "error") {
            send({ type: "error", message: describeProviderError(part.error, settings.provider) });
          }
        }
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
