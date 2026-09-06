import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart, LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  requireKontext: vi.fn(), existingRun: vi.fn(), beginGeneration: vi.fn(),
  generationContext: vi.fn(), saveGeneration: vi.fn(), collections: vi.fn(),
  acquireCapacity: vi.fn(), reserveModelCall: vi.fn(), releaseCapacity: vi.fn(),
  lock: vi.fn(), unlock: vi.fn(), quota: vi.fn(), refund: vi.fn(), usage: vi.fn(),
  model: vi.fn(), modelConfig: vi.fn(), sqlTool: vi.fn(), sqlExecute: vi.fn(), toStep: vi.fn(),
}));

vi.mock("@/lib/auth/user", () => ({
  requireKontext: mocks.requireKontext,
  NotSignedInError: class NotSignedInError extends Error {},
  NotAdminError: class NotAdminError extends Error {},
}));
vi.mock("@/lib/chat-generation", () => ({
  existingRun: mocks.existingRun, beginGeneration: mocks.beginGeneration,
  generationContext: mocks.generationContext, saveGeneration: mocks.saveGeneration,
}));
vi.mock("@/lib/collections", () => ({ ladeSammlungen: mocks.collections }));
vi.mock("@/lib/modellkatalog", () => ({ findeModell: mocks.modelConfig }));
vi.mock("@/lib/models", () => ({ modellFuerWerkzeuge: (model: string) => model }));
vi.mock("@/lib/capacity", () => ({
  acquireCapacity: mocks.acquireCapacity, reserveModelCall: mocks.reserveModelCall,
  withCapacity: async (_kind: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@/lib/ratelimit", () => ({
  erwirbSperre: mocks.lock, gibSperreFrei: mocks.unlock,
  pruefeFragekontingent: mocks.quota, gibFrageZurueck: mocks.refund,
}));
vi.mock("@/lib/verbrauch", () => ({ verbucheFrage: mocks.usage }));
vi.mock("@/lib/tools", () => ({
  baueCypherWerkzeug: () => ({}), baueSqlWerkzeug: mocks.sqlTool, toStep: mocks.toStep,
}));
vi.mock("@/lib/ai", () => ({
  SYSTEM_ANWEISUNG: "Antworte anhand der Quellen.",
  Fundstellensammler: class { alle: unknown[] = []; },
  baueKatalog: () => "Hundehalter: Tabelle mit Kennzahlen.",
  baueKontextblock: () => "Kontext", baueSuchwerkzeug: () => ({}),
  baueSystemanweisung: () => "Frage die Tabellen ab und beantworte die Nutzerfrage.",
  modell: mocks.model, sucheMitSchwelle: vi.fn(),
}));

// The real SDK owns prepareStep, tool execution, onStepEnd and finish-step order.
// Only the provider boundary and application services are replaced.
import { POST } from "@/app/api/chat/route";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const COLLECTION_ID = "33333333-3333-4333-8333-333333333333";
const run = {
  id: REQUEST_ID, chatId: CHAT_ID, userId: "user-a", attempt: 1,
  userMessageId: "44444444-4444-4444-8444-444444444444",
  assistantMessageId: "55555555-5555-4555-8555-555555555555", status: "streaming",
};
const question = "Welche Kennzahlen und auffaelligen Unterschiede finden sich in Hundehalter?";
const answer = "Es gibt 120 Hundehalter. Die groesste Gruppe lebt im Bezirk Nord; dort sind es 48.";
type Event = Record<string, unknown>;

function providerStream({ text, queries = [], outputTokens = 1200, finishReason = "tool-calls" }: {
  text: string; queries?: number[]; outputTokens?: number; finishReason?: LanguageModelV4FinishReason["unified"];
}): LanguageModelV4StreamResult {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
    ...queries.map((n): LanguageModelV4StreamPart => ({
      type: "tool-call", toolCallId: `sql-${n}`, toolName: "sql_ausfuehren",
      input: JSON.stringify({ sql: `SELECT ${n} AS kennzahl` }),
    })),
    {
      type: "finish", finishReason: { unified: finishReason, raw: undefined },
      usage: {
        inputTokens: { total: 1000, noCache: 900, cacheRead: 100, cacheWrite: undefined },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      },
    },
  ];
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) };
}

async function requestEvents(): Promise<Event[]> {
  const response = await POST(new Request("https://test.invalid/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: CHAT_ID, requestId: REQUEST_ID, question, detail: "compact" }),
  }));
  expect(response.status).toBe(200);
  return (await response.text()).trim().split("\n").map(line => JSON.parse(line));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireKontext.mockResolvedValue({ userId: "user-a", plan: { modelId: "test/model", maxQuestionsPerDay: 100 } });
  mocks.existingRun.mockResolvedValue(null);
  mocks.beginGeneration.mockResolvedValue(run);
  mocks.generationContext.mockResolvedValue([{ role: "user", content: question }]);
  mocks.collections.mockResolvedValue([{ id: COLLECTION_ID, name: "Hundehalter", kind: "sql" }]);
  mocks.saveGeneration.mockResolvedValue(undefined);
  mocks.acquireCapacity.mockResolvedValue(mocks.releaseCapacity);
  for (const dependency of [mocks.releaseCapacity, mocks.reserveModelCall, mocks.unlock, mocks.quota, mocks.refund, mocks.usage]) {
    dependency.mockResolvedValue(undefined);
  }
  mocks.lock.mockResolvedValue(true);
  mocks.modelConfig.mockResolvedValue({ id: "test/model" });
  mocks.sqlExecute.mockImplementation(async () => ({
    ok: true, collection: "Hundehalter", columns: ["anzahl"], rows: [[120]], rowCount: 1, truncated: false,
  }));
  mocks.sqlTool.mockReturnValue(tool({
    description: "Fuehrt eine lesende SQL-Abfrage aus.",
    inputSchema: z.object({ sql: z.string() }), execute: mocks.sqlExecute,
  }));
  mocks.toStep.mockImplementation((_collections, toolName, input, output) => ({
    tool: toolName, collectionId: COLLECTION_ID, collectionName: "Hundehalter", query: input.sql,
    rowCount: output.rowCount, columns: output.columns, preview: output.rows, truncated: output.truncated,
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("Chat-API mit echtem AI SDK", () => {
  it("reserviert nach drei vollen Rechercheaufrufen eine werkzeugfreie Schlussantwort und speichert alle acht SQL-Schritte", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      providerStream({ text: "Ich untersuche zunaechst die Kennzahlen. ".repeat(100), queries: [1, 2, 3] }),
      providerStream({ text: "Ich pruefe weitere Unterschiede. ".repeat(100), queries: [4, 5, 6] }),
      providerStream({ text: "Ich vergleiche noch die Bezirke. ".repeat(100), queries: [7, 8] }),
      providerStream({ text: answer, outputTokens: 80, finishReason: "stop" }),
    ] });
    mocks.model.mockResolvedValue(model);

    const output = await requestEvents();
    expect(output.filter(event => event.type === "error")).toEqual([]);
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: answer }]);
    expect(output.filter(event => event.type === "step")).toHaveLength(8);
    expect(output.at(-1)).toMatchObject({
      type: "done", status: "completed", modelInvoked: true, usageComplete: true,
      usage: { inputTokens: 4000, outputTokens: 3680, inputTokenDetails: { cacheReadTokens: 400 } },
    });
    expect(model.doStreamCalls).toHaveLength(4);
    expect(model.doStreamCalls.map(call => call.maxOutputTokens)).toEqual([1200, 1200, 1200, 2400]);
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls[3].toolChoice).toEqual({ type: "none" });
    expect(model.doStreamCalls[3].tools).toBeUndefined();
    expect(JSON.stringify(model.doStreamCalls[3].prompt)).toContain("120");
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(8);
    expect(mocks.reserveModelCall).toHaveBeenCalledTimes(4);
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({
      content: answer, status: "completed", steps: expect.arrayContaining([
        expect.objectContaining({ query: "SELECT 8 AS kennzahl", preview: [[120]] }),
      ]),
    }));
    expect(mocks.saveGeneration.mock.calls.at(-1)?.[1].steps).toHaveLength(8);
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("rettet einen vom Provider abgeschnittenen Recherchetext durch einen gesonderten Schlussaufruf", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      providerStream({ text: "Ich lese die Ausgangsdaten.", queries: [1] }),
      providerStream({ text: "Unvollstaendiger Recherchetext", finishReason: "length" }),
      providerStream({ text: answer, outputTokens: 80, finishReason: "stop" }),
    ] });
    mocks.model.mockResolvedValue(model);

    const output = await requestEvents();
    expect(output.filter(event => event.type === "error")).toEqual([]);
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: answer }]);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", usageComplete: true });
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[2].maxOutputTokens).toBe(2400);
    expect(model.doStreamCalls[2].toolChoice).toEqual({ type: "none" });
    expect(model.doStreamCalls[2].tools).toBeUndefined();
    expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain("SELECT 1 AS kennzahl");
    expect(mocks.sqlExecute).toHaveBeenCalledOnce();
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: answer, status: "completed" }));
  });
});
