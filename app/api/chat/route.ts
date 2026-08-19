import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, SYSTEM_PROMPT, buildContext, getClient } from "@/lib/anthropic";
import { MissingConfigError } from "@/lib/env";
import { search, type Hit } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Treffer unterhalb dieser Aehnlichkeit sind erfahrungsgemaess Rauschen. */
const MIN_SCORE = 0.35;
const TOP_K = 8;

type ClientMessage = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  const { messages } = (await request.json().catch(() => ({}))) as {
    messages?: ClientMessage[];
  };

  const history = (messages ?? []).filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  );

  const question = [...history].reverse().find((message) => message.role === "user")?.content;
  if (!question) {
    return Response.json({ error: "Es wurde keine Frage uebermittelt." }, { status: 400 });
  }

  let hits: Hit[];
  try {
    hits = (await search(question, TOP_K)).filter((hit) => hit.score >= MIN_SCORE);
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

  let client;
  try {
    client = getClient();
  } catch (error) {
    return errorResponse(error);
  }

  const apiMessages: Anthropic.MessageParam[] = history.map((message, i) =>
    i === history.length - 1 && message.role === "user"
      ? { role: "user", content: `${buildContext(hits)}\n\nFrage: ${message.content}` }
      : { role: message.role, content: message.content },
  );

  const encoder = new TextEncoder();
  const sources = hits.map((hit, i) => ({
    n: i + 1,
    filename: hit.metadata.filename,
    location: hit.metadata.location ?? null,
    score: Math.round(hit.score * 1000) / 1000,
    snippet: hit.metadata.text.slice(0, 240),
  }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      send({ type: "sources", sources });

      try {
        const messageStream = client.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: apiMessages,
          // Denken bleibt aktiv (auf Opus 5 der Standard), wird aber gedrosselt:
          // Der Chat soll zuegig antworten, nicht maximal gruebeln.
          output_config: { effort: "medium" },
        });

        for await (const event of messageStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", delta: event.delta.text });
          }
        }

        send({ type: "done" });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Unbekannter Fehler.",
        });
      } finally {
        controller.close();
      }
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

function ndjsonResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error: unknown): Response {
  const status = error instanceof MissingConfigError ? 503 : 500;
  const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
  return Response.json({ error: message }, { status });
}
