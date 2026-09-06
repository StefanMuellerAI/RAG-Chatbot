import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireKontext: vi.fn(), existingRun: vi.fn(), vorlauf: vi.fn(), previous: vi.fn(),
  plane: vi.fn(), schreibeGeneration: vi.fn(),
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
  existingRun: mocks.existingRun, ladeVorlauf: mocks.vorlauf, planeGeneration: mocks.plane,
  schreibeGeneration: mocks.schreibeGeneration, saveGeneration: mocks.saveGeneration,
}));
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
import { NotFoundError, RateLimitError, ResourceBusyError } from "@/lib/errors";

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
type StepSettings = {
  maxOutputTokens: number; toolChoice?: "none" | "required"; activeTools?: string[];
  messages?: unknown[]; instructions?: string;
};
type ModelOptions = {
  messages: unknown[]; instructions: string; abortSignal: AbortSignal;
  prepareStep: (args: { stepNumber: number; messages: unknown[]; instructions: string }) => Promise<StepSettings>;
  onStepEnd: (args: { usage: { inputTokens: number; outputTokens: number } }) => void;
};
type ModelStep = {
  parts: Event[]; finishReason: "stop" | "tool-calls" | "length" | undefined;
  outputTokens: number; messages?: unknown[]; responseMessages?: unknown[];
};

function modelCalls(...calls: ModelStep[][]): StepSettings[][] {
  const prepared: StepSettings[][] = [];
  mocks.streamText.mockImplementation((options: ModelOptions) => {
    const steps = calls[prepared.length];
    if (!steps) throw new Error("Unexpected model call");
    const settings: StepSettings[] = [];
    prepared.push(settings);
    return {
      responseMessages: Promise.resolve(steps.flatMap(step => step.responseMessages ?? [])),
      stream: (async function* () {
        for (const [stepNumber, step] of steps.entries()) {
          settings.push(await options.prepareStep({ stepNumber, messages: step.messages ?? options.messages, instructions: options.instructions }));
          for (const part of step.parts) yield part;
          options.onStepEnd({ usage: { inputTokens: 100, outputTokens: step.outputTokens } });
          if (step.finishReason) yield { type: "finish-step", finishReason: step.finishReason };
        }
      })(),
    };
  });
  return prepared;
}

function sqlStep(outputTokens = 1200): ModelStep {
  return {
    parts: [
      { type: "tool-call", toolName: "sql_ausfuehren", input: { sql: "SELECT COUNT(*) FROM hunde" } },
      { type: "tool-result", toolName: "sql_ausfuehren", input: { sql: "SELECT COUNT(*) FROM hunde" }, output: { ok: true, columns: ["count"], rows: [[123]] } },
    ],
    finishReason: "tool-calls", outputTokens,
  };
}

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
  // Der Vorlauf kommt aus einem Batch; die Einzelteile bleiben je Test einstellbar.
  mocks.previous.mockReturnValue(null);
  mocks.vorlauf.mockImplementation(async () => ({
    previous: mocks.previous(), history: await mocks.generationContext(), sammlungen: await mocks.collections(),
  }));
  mocks.plane.mockImplementation((_userId: string, _request: unknown, previous: { run: typeof run } | null) =>
    ({ run: previous?.run ?? run, neu: !previous }));
  mocks.schreibeGeneration.mockResolvedValue(true);
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
      yield { type: "finish-step", finishReason: "stop" };
    })(),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("Chat-API: Autorisierung und stabile Anfragekennungen", () => {
  it("weist unangemeldete Anfragen vor jeder weiteren Arbeit ab", async () => {
    mocks.requireKontext.mockRejectedValue(new NotSignedInError());
    expect((await POST(request())).status).toBe(401);
    expect(mocks.vorlauf).not.toHaveBeenCalled();
    expect(mocks.schreibeGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, chatId: "invalid" }, { ...body, requestId: "invalid" },
    { ...body, question: " " }, { ...body, question: "x".repeat(2001) },
    { ...body, collectionIds: ["invalid"] },
  ])("weist ungueltige Eingaben vor Persistenz und Kontingent ab", async (input) => {
    expect((await POST(request(input))).status).toBe(400);
    expect(mocks.schreibeGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("gibt einen fremden Chat nicht frei und laesst die parallel genommene Sperre nicht liegen", async () => {
    mocks.vorlauf.mockRejectedValue(new NotFoundError("Der Chat"));
    const output = await events(await POST(request()));
    expect(output[0]).toMatchObject({ type: "status", phase: "queued" });
    expect(output.find((event) => event.type === "error")).toMatchObject({
      reason: "nicht_gefunden", message: expect.stringContaining("nicht gefunden"),
    });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: false });
    expect(mocks.schreibeGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("liefert eine abgeschlossene Anfrage ohne neue Modellarbeit und Kontingent zurueck", async () => {
    mocks.previous.mockReturnValue({
      run: { ...run, status: "completed" },
      answer: { content: "Gespeicherte Antwort", sources: [hit], steps: [] },
    });
    const output = await events(await POST(request()));
    expect(output).toContainEqual({ type: "text", delta: "Gespeicherte Antwort" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: false, replayed: true });
    expect(mocks.schreibeGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    // Die Sperre wird parallel zum Lesen genommen und danach wieder freigegeben.
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("weist eine gleichzeitige Anfrage im selben Chat als Fehler mit Wartezeit ab", async () => {
    mocks.lock.mockResolvedValue(false);
    const output = await events(await POST(request()));
    expect(output.find((event) => event.type === "error")).toMatchObject({ reason: "bereits_aktiv", retryAfter: 3 });
    expect(output.some((event) => event.type === "start")).toBe(false);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: false });
    expect(mocks.schreibeGeneration).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("wiederholt kein Modell, wenn die erste Anfrage zwischen Lesen und Schreiben fertig wird", async () => {
    mocks.schreibeGeneration.mockResolvedValue(false);
    mocks.existingRun.mockResolvedValue({
      run: { ...run, status: "completed" },
      answer: { content: "Inzwischen gespeicherte Antwort", sources: [hit], steps: [] },
    });
    const output = await events(await POST(request()));
    expect(output).toContainEqual({ type: "text", delta: "Inzwischen gespeicherte Antwort" });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", modelInvoked: false, replayed: true });
    // Das Kontingent lief parallel zum Schreiben und geht zurueck: es gab keine neue Antwort.
    expect(mocks.refund).toHaveBeenCalledOnce();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.saveGeneration).not.toHaveBeenCalled();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });
});

describe("Chat-API: Stream, Speichern und Fehler", () => {
  it("meldet eine belegte Graphsammlung ohne dem Nutzer zu viele Anfragen vorzuwerfen", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "graph" }]);
    const error = new ResourceBusyError();
    mocks.parts = [{ type: "tool-error", toolName: "cypher_ausfuehren", input: { cypher: "MATCH (n) RETURN n" }, error }];
    const output = await events(await POST(request()));
    expect(output.find((event) => event.type === "error")).toEqual({ type: "error", message: error.message, code: "failed", reason: "sammlung_belegt", retryAfter: 5 });
    expect(JSON.stringify(output)).not.toContain("Zu viele Anfragen");
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expect(mocks.streamText).toHaveBeenCalledOnce();
    expect(mocks.refund).toHaveBeenCalledOnce();
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });

  it("behaelt echte Nutzerlimits bei und startet dann weder Modell noch Werkzeuge", async () => {
    mocks.quota.mockRejectedValue(new RateLimitError(30));
    const output = await events(await POST(request()));
    expect(output).toContainEqual(expect.objectContaining({ type: "error", retryAfter: 30, message: expect.stringContaining("Zu viele Anfragen") }));
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed", modelInvoked: false });
    expect(mocks.streamText).not.toHaveBeenCalled();
    // Die Zulassung laeuft parallel zum Kontingent und wird sofort wieder freigegeben.
    expect(mocks.releaseCapacity).toHaveBeenCalledOnce();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

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
    expect(output[0]).toMatchObject({ type: "status", phase: "queued" });
    expect(output.find((event) => event.type === "start")).toMatchObject({ requestId: REQUEST_ID, userMessageId: USER_MESSAGE_ID, assistantMessageId: ASSISTANT_MESSAGE_ID });
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
    // Das Modell wartet, bis der Empfaenger weg ist: erst dann darf die Generierung weiterlaufen.
    let freigeben!: () => void;
    const tor = new Promise<void>((resolve) => { freigeben = resolve; });
    mocks.model.mockImplementation(async () => { await tor; return {}; });
    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let gelesen = "";
    while (!gelesen.includes('"type":"start"')) {
      const { value, done } = await reader.read();
      if (done) break;
      gelesen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    freigeben();
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

describe("Chat-API: Recherchebudget und abgeschlossene Antworten", () => {
  it("reserviert nach drei SQL-Rechercheschritten ein separates Budget fuer die Antwort", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    const prepared = modelCalls([
      sqlStep(), sqlStep(), sqlStep(),
      { parts: [{ type: "text-delta", text: "Die Tabelle enthaelt 123 Hunde." }], finishReason: "stop", outputTokens: 2400 },
    ]);
    const output = await events(await POST(request()));

    expect(prepared[0].map(step => step.maxOutputTokens)).toEqual([1200, 1200, 1200, 2400]);
    expect(prepared[0][0].toolChoice).toBe("required");
    expect(prepared[0][3]).toMatchObject({ toolChoice: "none", activeTools: [] });
    expect(prepared[0][3].instructions).toContain("Keine weiteren Werkzeuge");
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: "Die Tabelle enthaelt 123 Hunde." }]);
    expect(output.some(event => event.type === "error")).toBe(false);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", usage: { inputTokens: 400, outputTokens: 6000 } });
    expect(mocks.streamText).toHaveBeenCalledOnce();
    expect(mocks.reserveModelCall).toHaveBeenCalledTimes(4);
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Die Tabelle enthaelt 123 Hunde.", status: "completed" }));
    expect(mocks.quota).toHaveBeenCalledOnce();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("beginnt bei knappem Gesamteingabebudget die Antwort bevor eine weitere Recherche das Budget verbraucht", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    mocks.generationContext.mockResolvedValue([
      { role: "user", content: "Vorherige Frage" },
      { role: "assistant", content: "x".repeat(22_000) },
      { role: "user", content: body.question },
    ]);
    const prepared = modelCalls([
      sqlStep(100), sqlStep(100),
      { parts: [{ type: "text-delta", text: "Die vorhandenen Ergebnisse zeigen 123 Hunde." }], finishReason: "stop", outputTokens: 80 },
    ]);
    const output = await events(await POST(request()));

    expect(prepared[0].map(step => step.maxOutputTokens)).toEqual([1200, 1200, 2400]);
    expect(prepared[0][2]).toMatchObject({ toolChoice: "none", activeTools: [] });
    const reservedTokens = mocks.reserveModelCall.mock.calls.map(call => call[1] as number);
    expect(reservedTokens.reduce((total, tokens) => total + tokens, 0)).toBeLessThanOrEqual(100_000);
    expect(output.some(event => event.type === "error")).toBe(false);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", usage: { outputTokens: 280 } });
    expect(mocks.streamText).toHaveBeenCalledOnce();
  });

  it("verwirft einen Werkzeug-Zwischenkommentar und formuliert anschliessend aus den vorhandenen Ergebnissen eine Antwort", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    const responseMessages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "sql-1", toolName: "sql_ausfuehren", input: { sql: "SELECT COUNT(*) FROM hunde" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "sql-1", toolName: "sql_ausfuehren", output: { type: "json", value: { columns: ["count"], rows: [[123]] } } }] },
    ];
    const research = sqlStep(200);
    research.parts.unshift({ type: "text-delta", text: "Ich pruefe jetzt die Verteilung." });
    research.responseMessages = responseMessages;
    const prepared = modelCalls([research], [
      { parts: [{ type: "text-delta", text: "Ergebnis: 123 Hunde." }], finishReason: "stop", outputTokens: 50 },
    ]);
    const output = await events(await POST(request()));

    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(prepared[1][0]).toMatchObject({ maxOutputTokens: 2400, toolChoice: "none", activeTools: [] });
    expect(prepared[1][0].messages).toEqual([{ role: "user", content: body.question }, ...responseMessages]);
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: "Ergebnis: 123 Hunde." }]);
    expect(JSON.stringify(output)).not.toContain("Ich pruefe jetzt");
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Ergebnis: 123 Hunde.", status: "completed" }));
  });

  it("schliesst eine wegen length beendete Recherche mit genau einem separaten Antwortaufruf ab", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    const prepared = modelCalls([
      sqlStep(1000),
      { parts: [{ type: "text-delta", text: "Eine noch nicht abgeschlossene Recherche ..." }], finishReason: "length", outputTokens: 1200 },
    ], [
      { parts: [{ type: "text-delta", text: "Die Ergebnisse erlauben diese Zusammenfassung." }], finishReason: "stop", outputTokens: 100 },
    ]);
    const output = await events(await POST(request()));

    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(prepared[1][0]).toMatchObject({ maxOutputTokens: 2400, toolChoice: "none", activeTools: [] });
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: "Die Ergebnisse erlauben diese Zusammenfassung." }]);
    expect(output.some(event => event.type === "error")).toBe(false);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed", usage: { outputTokens: 2300 } });
  });

  it("uebernimmt fuer einen Finalstream ohne Abschlussereignis nicht das stop der leeren Recherche", async () => {
    mocks.collections.mockResolvedValue([{ ...collection, kind: "sql" }]);
    modelCalls([
      { parts: [], finishReason: "stop", outputTokens: 10 },
    ], [
      { parts: [{ type: "text-delta", text: "Begonnene Antwort." }], finishReason: undefined, outputTokens: 30 },
    ]);
    const output = await events(await POST(request()));

    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(output.filter(event => event.type === "text").map(event => event.delta).join("")).toBe("Begonnene Antwort.");
    expect(output.some(event => event.type === "error")).toBe(true);
    expect(output.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Begonnene Antwort.", status: "failed" }));
  });

  it.each([
    { finishReason: "stop" as const, status: "completed" },
    { finishReason: "length" as const, status: "failed" },
  ])("speichert Antworttext bei finishReason $finishReason mit Status $status", async ({ finishReason, status }) => {
    const prepared = modelCalls([
      { parts: [{ type: "text-delta", text: "Bereits formulierter Antworttext." }], finishReason, outputTokens: 2400 },
    ]);
    const output = await events(await POST(request()));

    expect(prepared[0][0]).toMatchObject({ maxOutputTokens: 2400, toolChoice: "none", activeTools: [] });
    expect(output.filter(event => event.type === "text")).toEqual([{ type: "text", delta: "Bereits formulierter Antworttext." }]);
    expect(output.at(-1)).toMatchObject({ type: "done", status });
    expect(mocks.saveGeneration).toHaveBeenLastCalledWith(run, expect.objectContaining({ content: "Bereits formulierter Antworttext.", status }));
    expect(mocks.streamText).toHaveBeenCalledOnce();
    if (finishReason === "length") {
      expect(output).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("Ausgabelimit") }));
    } else expect(output.some(event => event.type === "error")).toBe(false);
  });

  it("reserviert fuer eine ausfuehrliche Antwort 4800 Ausgabetokens", async () => {
    const prepared = modelCalls([
      { parts: [{ type: "text-delta", text: "Eine ausfuehrliche Antwort." }], finishReason: "stop", outputTokens: 4800 },
    ]);
    const output = await events(await POST(request({ ...body, detail: "detailed" })));

    expect(prepared[0][0]).toMatchObject({ maxOutputTokens: 4800, toolChoice: "none", activeTools: [] });
    expect(output.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });
});
