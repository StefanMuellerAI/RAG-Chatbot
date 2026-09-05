import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireKontext: vi.fn(), existingRun: vi.fn(), beginGeneration: vi.fn(),
  generationContext: vi.fn(), saveGeneration: vi.fn(), collections: vi.fn(),
  acquireCapacity: vi.fn(), reserveModelCall: vi.fn(), releaseCapacity: vi.fn(),
  lock: vi.fn(), unlock: vi.fn(), quota: vi.fn(), refund: vi.fn(), usage: vi.fn(),
  model: vi.fn(), modelConfig: vi.fn(), search: vi.fn(), streamText: vi.fn(),
  afterPart: vi.fn(), parts: [] as Record<string, unknown>[],
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
  baueCypherWerkzeug: () => ({}), baueSqlWerkzeug: () => ({}), toStep: () => null,
}));
vi.mock("@/lib/ai", () => ({
  SYSTEM_ANWEISUNG: "Antworte anhand der Quellen.",
  Fundstellensammler: class {
    alle: unknown[] = [];
    fuegeHinzu(hits: unknown[]) { this.alle.push(...hits); return hits; }
  },
  baueKatalog: () => "Katalog", baueKontextblock: () => "Kontext",
  baueSuchwerkzeug: () => ({}), baueSystemanweisung: () => "System",
  modell: mocks.model, sucheMitSchwelle: mocks.search,
}));
vi.mock("ai", () => ({ streamText: mocks.streamText, isStepCount: (count: number) => count }));

import { POST } from "@/app/api/chat/route";
import { NotSignedInError } from "@/lib/auth/user";
import { NotFoundError, RateLimitError } from "@/lib/errors";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const COLLECTION_ID = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const ASSISTANT_MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const run = {
  id: REQUEST_ID, chatId: CHAT_ID, userId: "user-a", attempt: 1,
  userMessageId: USER_MESSAGE_ID, assistantMessageId: ASSISTANT_MESSAGE_ID, status: "streaming",
};
const body = { chatId: CHAT_ID, requestId: REQUEST_ID, question: "Welche Regeln gelten?" };
const hit = { n: 1, filename: "Handbuch.pdf", location: "S. 1", score: 0.9, snippet: "Testbeleg", collectionName: "Handbuch" };
const collection = { id: COLLECTION_ID, name: "Handbuch", kind: "vector" };
type Event = Record<string, unknown>;
type ModelOptions = {
  messages: unknown[]; instructions: string; abortSignal: AbortSignal;
  prepareStep: (args: { stepNumber: number; messages: unknown[]; instructions: string }) => Promise<unknown>;
  onStepEnd: (args: { usage: { inputTokens: number; outputTokens: number } }) => void;
};

function request(value: unknown = body, signal?: AbortSignal) {
  return new Request("https://test.invalid/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal,
  });
}

async function events(response: Response, onEvent?: (event: Event) => void): Promise<Event[]> {
  if (!response.body) throw new Error("Missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const output: Event[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Event;
      output.push(event); onEvent?.(event);
    }
    if (done) break;
  }
  expect(buffer.trim()).toBe("");
  return output;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireKontext.mockResolvedValue({ userId: "user-a", plan: { modelId: "test/model", maxQuestionsPerDay: 100 } });
  mocks.existingRun.mockResolvedValue(null);
  mocks.beginGeneration.mockResolvedValue(run);
  mocks.generationContext.mockResolvedValue([{ role: "user", content: body.question }]);
  mocks.saveGeneration.mockResolvedValue(undefined);
  mocks.collections.mockResolvedValue([collection]);
  mocks.acquireCapacity.mockResolvedValue(mocks.releaseCapacity);
  mocks.releaseCapacity.mockResolvedValue(undefined);
  mocks.reserveModelCall.mockResolvedValue(undefined);
  mocks.lock.mockResolvedValue(true);
  mocks.unlock.mockResolvedValue(undefined);
  mocks.quota.mockResolvedValue(undefined);
  mocks.refund.mockResolvedValue(undefined);
  mocks.usage.mockResolvedValue(undefined);
  mocks.modelConfig.mockResolvedValue({ id: "test/model" });
  mocks.model.mockResolvedValue({});
  mocks.search.mockResolvedValue([hit]);
  mocks.parts = [{ type: "text-delta", text: "Eine belegte Antwort." }];
  mocks.streamText.mockImplementation((options: ModelOptions) => ({
    responseMessages: Promise.resolve([]),
    stream: (async function* () {
      await options.prepareStep({ stepNumber: 0, messages: options.messages, instructions: options.instructions });
      for (const part of mocks.parts) { yield part; mocks.afterPart(part); }
      options.onStepEnd({ usage: { inputTokens: 100, outputTokens: 10 } });
    })(),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("Chat-API: Autorisierung und stabile Anfragekennungen", () => {
  it("weist unangemeldete Anfragen vor jeder weiteren Arbeit ab", async () => {
    mocks.requireKontext.mockRejectedValue(new NotSignedInError());
    expect((await POST(request())).status).toBe(401);
    expect(mocks.existingRun).not.toHaveBeenCalled();
    expect(mocks.beginGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, chatId: "invalid" }, { ...body, requestId: "invalid" },
    { ...body, question: " " }, { ...body, question: "x".repeat(2001) },
    { ...body, collectionIds: ["invalid"] },
  ])("weist ungueltige Eingaben vor Persistenz und Kontingent ab", async (input) => {
    expect((await POST(request(input))).status).toBe(400);
    expect(mocks.beginGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("gibt einen fremden Chat nicht frei", async () => {
    mocks.existingRun.mockRejectedValue(new NotFoundError("Der Chat"));
    expect((await POST(request())).status).toBe(404);
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("liefert eine abgeschlossene Anfrage ohne neue Modellarbeit und Kontingent zurueck", async () => {
    mocks.existingRun.mockResolvedValue({
      run: { ...run, status: "completed" },
      answer: { content: "Gespeicherte Antwort", sources: [hit], steps: [] },
    });
    const output = await events(await POST(request()));
    expect(output).toContainEqual({ type: "text", delta: "Gespeicherte Antwort" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: false, replayed: true });
    expect(mocks.beginGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it("weist eine gleichzeitige Anfrage im selben Chat mit 409 ab", async () => {
    mocks.lock.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect((await response.json()).code).toBe("bereits_aktiv");
    expect(mocks.beginGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("wiederholt kein Modell, wenn die erste Anfrage zwischen Lesen und Sperrerwerb fertig wird", async () => {
    mocks.existingRun.mockResolvedValueOnce(null).mockResolvedValueOnce({
      run: { ...run, status: "completed" },
      answer: { content: "Inzwischen gespeicherte Antwort", sources: [hit], steps: [] },
    });
    mocks.beginGeneration.mockResolvedValue({ ...run, status: "completed" });
    const output = await events(await POST(request()));
    expect(output).toContainEqual({ type: "text", delta: "Inzwischen gespeicherte Antwort" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: false, replayed: true });
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.saveGeneration).not.toHaveBeenCalled();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });
});

describe("Chat-API: Stream, Speichern und Fehler", () => {
  it("beendet den Stream bei einer vom SDK umgewandelten Werkzeug-Ueberlastung", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    mocks.parts = [{ type: "tool-error", toolName: "sql_ausfuehren", input: { sql: "SELECT 1" }, error: new RateLimitError(3) }];
    const output = await events(await POST(request()));
    expect(output).toContainEqual(expect.objectContaining({ type: "error", retryAfter: 3 }));
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expect(mocks.streamText).toHaveBeenCalledOnce();
  });
  it("speichert die vollstaendige Antwort vor done und gibt die Kapazitaet frei", async () => {
    let saved = false;
    mocks.saveGeneration.mockImplementation(async (_run, state) => {
      if (state.status === "completed") saved = true;
    });
    const output = await events(await POST(request()), (event) => {
      if (event.type === "done") expect(saved).toBe(true);
    });
    expect(output[0]).toMatchObject({ type: "start", requestId: REQUEST_ID, userMessageId: USER_MESSAGE_ID, assistantMessageId: ASSISTANT_MESSAGE_ID });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: true, usage: { inputTokens: 100, outputTokens: 10 } });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Eine belegte Antwort.", status: "completed", sources: [hit] }));
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("verhindert eine fremde Sammlung vor Modell, Suche und Kontingent", async () => {
    const output = await events(await POST(request({ ...body, collectionIds: ["66666666-6666-4666-8666-666666666666"] })));
    expect(output.find((event) => event.type === "error")).toMatchObject({ code: "failed" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: false });
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("filtert erlaubte Sammlungen auf den ausdruecklich ausgewaehlten Umfang", async () => {
    mocks.collections.mockResolvedValue([collection, { ...collection, id: "66666666-6666-4666-8666-666666666666", name: "Andere" }]);
    await events(await POST(request({ ...body, collectionIds: [COLLECTION_ID] })));
    expect(mocks.search).toHaveBeenCalledWith(collection, body.question, expect.any(AbortSignal));
  });

  it("liefert nach einem Modellfehler error und terminal failed, mit gespeichertem Teiltext", async () => {
    mocks.parts = [{ type: "text-delta", text: "Schon vorhanden." }, { type: "error", error: new Error("PRIVATE-PROVIDER-DETAIL") }];
    const output = await events(await POST(request()));
    expect(output.some((event) => event.type === "error")).toBe(true);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: true });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Schon vorhanden.", status: "failed" }));
    expect(JSON.stringify(output)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("behaelt bei Stopp den Teiltext und kennzeichnet die Antwort als aborted", async () => {
    const controller = new AbortController();
    mocks.parts = [{ type: "text-delta", text: "Teilantwort." }, { type: "text-delta", text: " Darf nicht erscheinen." }];
    mocks.afterPart.mockImplementationOnce(() => controller.abort());
    const output = await events(await POST(request(body, controller.signal)));
    expect(output.at(-1)).toMatchObject({ type: "done", status: "aborted" });
    expect(output.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "Teilantwort." }]);
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Teilantwort.", status: "aborted" }));
    expect(mocks.streamText.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("speichert beim Schliessen des Empfaengerstreams den Abbruch und gibt Sperren frei", async () => {
    const response = await POST(request());
    await response.body?.cancel();
    await vi.waitFor(() => {
      expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ status: "aborted" }));
      expect(mocks.unlock).toHaveBeenCalledOnce();
    });
  });

  it.each(["keine Sammlungen", "keine Fundstellen"])("zaehlt %s nicht als Modellantwort und erstattet das Kontingent", async (kind) => {
    if (kind === "keine Sammlungen") mocks.collections.mockResolvedValue([]);
    else mocks.search.mockResolvedValue([]);
    const output = await events(await POST(request()));
    expect(output.some((event) => event.type === "text")).toBe(true);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: false });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.refund).toHaveBeenCalledWith("user-a");
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("zaehlt ein leeres Modellergebnis als Fehler", async () => {
    mocks.parts = [];
    const output = await events(await POST(request()));
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: true });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ status: "failed" }));
  });

  it("beendet eine volle Kapazitaetswarteschlange als Fehler mit Retry-Angabe", async () => {
    mocks.acquireCapacity.mockRejectedValue(new RateLimitError(5));
    const output = await events(await POST(request()));
    expect(output.find((event) => event.type === "error")).toMatchObject({ retryAfter: 5 });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: false });
    expect(mocks.refund).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("meldet einen Speicherfehler statt eines erfolgreichen Abschlusses", async () => {
    mocks.saveGeneration.mockRejectedValue(new Error("Database unavailable"));
    const output = await events(await POST(request()));
    expect(output.find((event) => event.code === "speichern")).toMatchObject({ type: "error" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it.each(["refund", "usage", "releaseCapacity", "unlock"] as const)("schliesst den Stream auch bei Fehler in %s", async (dependency) => {
    mocks[dependency].mockRejectedValue(new Error("Service unavailable"));
    if (dependency === "refund") mocks.search.mockResolvedValue([]);
    const output = await events(await POST(request()));
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });
});
