import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoadChat, measureQuestion, percentiles, registerAuthenticatedUser, reportStage, runLoadStage,
  summarizeMeasurements, validateFixture, validateStages, validateTarget,
  type FetchLike, type LoadIdentity, type LoadMeasurement, type LoadScenario,
} from "@/lib/loadtest";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTION_ID = "22222222-2222-4222-8222-222222222222";
const scenario: LoadScenario = { type: "vector", question: "Testfrage", collectionIds: [COLLECTION_ID] };
const identity = (index = 1): LoadIdentity => ({
  id: `test-${index}`, cookie: `__session=PRIVATE-COOKIE-${index}`, scenarios: [scenario],
});
const prepared = { identity: identity(), chatId: CHAT_ID, authenticatedUserId: "user_PRIVATE_ACCOUNT_1" };
const options = { url: "https://test.invalid", timeoutMs: 1_000 };
const text = { type: "text", delta: "PRIVATE-ANSWER" };
const completed = { type: "done", status: "completed", modelInvoked: true, usage: { inputTokens: 123, outputTokens: 7 } };
const headers = { "Content-Type": "application/x-ndjson" };
const ndjson = (events: unknown[]) => new Response(events.map((event) => JSON.stringify(event)).join("\n"), { headers });
const measure = (events: unknown[]) => measureQuestion(prepared, scenario, {
  ...options, fetchFn: async () => ndjson(events),
});

afterEach(() => vi.useRealTimers());

describe("Fixture und Ziel validieren", () => {
  it("verlangt verschiedene Identitaeten und Cookies fuer die Laststufe", () => {
    expect(validateFixture({ identities: [identity(), identity(2)] }, 2).identities).toHaveLength(2);
    expect(() => validateFixture({ identities: [identity()] }, 100)).toThrow("mindestens 100");
    expect(() => validateFixture({ identities: [identity(), identity()] }, 2)).toThrow("doppelte Kennung");
    expect(() => validateFixture({ identities: [identity(), { ...identity(2), cookie: identity().cookie }] }, 2)).toThrow("ein Cookie");
  });

  it("lehnt ungueltige Szenarien ab, ohne Werte aus der Fixture preiszugeben", () => {
    const invalid = { ...identity(), scenarios: [{ ...scenario, type: "PRIVATE-SECRET" }] };
    expect(() => validateFixture({ identities: [invalid] }, 1)).toThrow("vector, sql oder graph");
    try { validateFixture({ identities: [invalid] }, 1); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE-");
    }
    expect(() => validateFixture({ identities: [{ ...identity(), cookie: "private\r\nheader" }] }, 1)).toThrow("Cookie-Header");
    expect(() => validateFixture({ identities: [{ ...identity(), scenarios: [{ ...scenario, question: " " }] }] }, 1)).toThrow("question");
    expect(() => validateFixture({ identities: [{ ...identity(), scenarios: [{ ...scenario, collectionIds: ["invalid"] }] }] }, 1)).toThrow("Sammlungs-UUIDs");
  });

  it("erlaubt nur feste aufsteigende Stufen und eine Origin ohne Zugangsdaten", () => {
    expect(validateStages("100,250,500,1000")).toEqual([100, 250, 500, 1_000]);
    expect(validateStages("100,1000")).toEqual([100, 1_000]);
    for (const value of ["", "0", "NaN", "100,100", "500,100", "100,Infinity", "101"]) {
      expect(() => validateStages(value)).toThrow();
    }
    expect(validateTarget("http://localhost:3000/")).toBe("http://localhost:3000");
    for (const value of ["https://name:PRIVATE@test.invalid", "https://test.invalid/?token=PRIVATE", "https://test.invalid/api/chat", "file:///tmp/test"]) {
      expect(() => validateTarget(value)).toThrow("Origin");
    }
  });
});

describe("NDJSON-Auswertung", () => {
  it("misst TTFT, Status und Phasen bis zum ausdruecklichen Abschluss", async () => {
    let clock = 0;
    const chunks = [
      [10, { type: "status", phase: "queued" }],
      [30, { type: "status", phase: "retrieval" }],
      [80, { type: "status", phase: "generating" }],
      [90, text],
      [100, { type: "status", phase: "saving" }],
      [110, completed],
    ] as const;
    let next = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (next === chunks.length) { controller.close(); return; }
        const [at, event] = chunks[next++];
        clock = at;
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      },
    }, { highWaterMark: 0 }), { headers });
    const result = await measureQuestion(prepared, scenario, { ...options, now: () => clock, fetchFn: async () => response });
    expect(result).toMatchObject({
      success: true, httpStatus: 200, doneStatus: "completed", modelInvoked: true,
      firstTextMs: 90, firstStatusMs: 10, totalMs: 110, inputTokens: 123, outputTokens: 7,
      phaseMs: { queued: 20, retrieval: 50, generating: 20, saving: 10 },
    });
  });

  it("liest aufgeteiltes UTF-8 und die letzte Zeile ohne Newline", async () => {
    const bytes = new TextEncoder().encode([JSON.stringify({ type: "text", delta: "Grüße" }), JSON.stringify(completed)].join("\n"));
    let index = 0;
    const result = await measureQuestion(prepared, scenario, { ...options, fetchFn: async () => new Response(new ReadableStream({
      pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(index, ++index));
      },
    }), { headers }) });
    expect(result.success).toBe(true);
    expect(result.hasText).toBe(true);
  });

  it.each([
    ["Fehler vor done", [text, { type: "error", message: "PRIVATE-ERROR" }, completed]],
    ["Fehler nach done", [text, completed, { type: "error", message: "PRIVATE-ERROR" }]],
    ["failed ohne Fehlerereignis", [text, { ...completed, status: "failed" }]],
    ["aborted ohne Fehlerereignis", [text, { ...completed, status: "aborted" }]],
  ])("zaehlt %s als Streamfehler", async (_label, events) => {
    const result = await measure(events);
    expect(result).toMatchObject({ success: false, failure: "stream" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
  });

  it("unterscheidet unvollstaendige, leere und statische Antworten", async () => {
    expect(await measure([text])).toMatchObject({ success: false, failure: "incomplete_stream" });
    expect(await measure([{ type: "text", delta: " \n" }, completed])).toMatchObject({ success: false, failure: "empty_answer", firstTextMs: null });
    const staticResult = await measure([text, { ...completed, modelInvoked: false }]);
    expect(staticResult.success).toBe(true);
    expect(summarizeMeasurements([staticResult], 1_000)).toMatchObject({
      successfulAnswers: 1, successfulModelAnswers: 0, successfulWithoutModel: 1,
      ratesPerMinute: { successfulModelAnswers: 0 },
      timingsMs: { firstModelTextSuccessful: { count: 0, p50: null, p95: null, p99: null } },
    });
  });

  it("erkennt fehlende Abschlussmetadaten, HTML und defektes JSON", async () => {
    expect(await measure([text, { type: "done" }])).toMatchObject({ success: false, failure: "protocol" });
    for (const response of [new Response("PRIVATE-HTML"), new Response("{PRIVATE-BROKEN", { headers })]) {
      const result = await measureQuestion(prepared, scenario, { ...options, fetchFn: async () => response });
      expect(result).toMatchObject({ success: false, failure: "protocol" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    }
  });

  it("unterscheidet HTTP- und Netzwerkfehler ohne fremde Fehlermeldungen zu loggen", async () => {
    const http = await measureQuestion(prepared, scenario, { ...options, fetchFn: async () => new Response("PRIVATE-ERROR", { status: 429 }) });
    const network = await measureQuestion(prepared, scenario, { ...options, fetchFn: async () => { throw new Error("PRIVATE-NETWORK"); } });
    expect(http).toMatchObject({ httpStatus: 429, failure: "http", success: false });
    expect(network).toMatchObject({ httpStatus: 0, failure: "network", success: false });
    expect(JSON.stringify([http, network])).not.toContain("PRIVATE-");
  });

  it("beendet auch einen nie abgeschlossenen Stream am Zeitlimit", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = measureQuestion(prepared, scenario, {
      ...options, timeoutMs: 50,
      fetchFn: async () => new Response(new ReadableStream({ cancel }), { headers }),
    });
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ success: false, failure: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("unterscheidet einen Benutzerabbruch vom Zeitlimit", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await measureQuestion(prepared, scenario, {
      ...options, signal: controller.signal,
      fetchFn: async () => new Response(new ReadableStream(), { headers }),
    });
    expect(result).toMatchObject({ success: false, failure: "aborted" });
  });
});

describe("Vorbereitung, Request-Vertrag und Berichte", () => {
  it("legt einen Chat pro Identitaet an und sendet Chat-ID und eindeutige Request-ID", async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) => url.endsWith("/api/chats")
      ? Response.json({ chat: { id: CHAT_ID }, authenticatedUserId: prepared.authenticatedUserId }) : ndjson([text, completed]));
    expect(await createLoadChat(identity(), { ...options, fetchFn })).toEqual({ chatId: CHAT_ID, authenticatedUserId: prepared.authenticatedUserId });
    await measureQuestion(prepared, scenario, { ...options, fetchFn });
    await measureQuestion(prepared, scenario, { ...options, fetchFn });
    const calls = fetchFn.mock.calls;
    expect(calls[0][0]).toBe("https://test.invalid/api/chats");
    expect(calls[1][1].redirect).toBe("manual");
    expect(calls[1][1].headers).toMatchObject({ Cookie: identity().cookie });
    const first = JSON.parse(calls[1][1].body as string);
    const second = JSON.parse(calls[2][1].body as string);
    expect(first).toMatchObject({ chatId: CHAT_ID, question: scenario.question, collectionIds: [COLLECTION_ID] });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.requestId).not.toBe(first.requestId);
    expect(first.messages).toBeUndefined();
    expect(first.authenticatedUserId).toBeUndefined();
  });

  it.each([undefined, null, "", "user id", "PRIVATE-EMAIL@example.org", 123])("bricht ohne gueltige serverseitige Konto-ID ab statt Fixture-Labels zu vertrauen", async (authenticatedUserId) => {
    const fetchFn = vi.fn<FetchLike>(async () => Response.json({ chat: { id: CHAT_ID }, authenticatedUserId }));
    await expect(createLoadChat(identity(), { ...options, fetchFn })).rejects.toThrow("authentifizierte Konto-ID");
    try { await createLoadChat(identity(), { ...options, fetchFn }); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE-");
    }
  });

  it("erkennt verschiedene Sitzungen desselben Kontos schon bei der Vorbereitung ohne IDs preiszugeben", async () => {
    const seen = new Set<string>();
    const fetchFn = vi.fn<FetchLike>(async () => Response.json({ chat: { id: crypto.randomUUID() }, authenticatedUserId: prepared.authenticatedUserId }));
    const first = await createLoadChat(identity(1), { ...options, fetchFn });
    const second = await createLoadChat(identity(2), { ...options, fetchFn });
    expect(first.chatId).not.toBe(second.chatId);
    expect(identity(1).cookie).not.toBe(identity(2).cookie);
    registerAuthenticatedUser(seen, first.authenticatedUserId);
    expect(() => registerAuthenticatedUser(seen, second.authenticatedUserId)).toThrow("selben Konto");
    try { registerAuthenticatedUser(seen, second.authenticatedUserId); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
    expect(seen.size).toBe(1);
    registerAuthenticatedUser(seen, "user_PRIVATE_ACCOUNT_2");
    expect(seen.size).toBe(2);
  });

  it("startet keine Modellanfrage, wenn eine Stufe doppelte authentifizierte Konten enthaelt", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ndjson([text, completed]));
    await expect(runLoadStage([
      prepared, { ...prepared, identity: identity(2), chatId: crypto.randomUUID() },
    ], { ...options, fetchFn, durationMs: 1_000, burst: true })).rejects.toThrow("selben Konto");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("berechnet p50/p95/p99 und Raten aus realer Dauer einschliesslich Drain", async () => {
    expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null, p99: null });
    expect(percentiles(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ count: 100, p50: 50, p95: 95, p99: 99 });
    const good = await measure([text, completed]);
    const failed = { ...good, scenario: "sql", success: false, failure: "stream" } as LoadMeasurement;
    const report = reportStage([good, failed], 120_000);
    expect(report.total.ratesPerMinute).toEqual({ requests: 1, successfulAnswers: 0.5, successfulModelAnswers: 0.5 });
    expect(report.total.modelTokens).toEqual({ input: 123, output: 7, answersWithOutputUsage: 1 });
    expect(report.byScenario.vector.requests).toBe(1);
    expect(report.byScenario.sql.failures).toEqual({ stream: 1 });
    expect(report.byScenario.graph.requests).toBe(0);
    expect(JSON.stringify(report)).not.toContain("PRIVATE-");
  });

  it("sendet im Burst genau eine Frage pro eigener Identitaet", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ndjson([text, completed]));
    const identities = Array.from({ length: 3 }, (_, i) => ({ identity: identity(i), chatId: crypto.randomUUID(), authenticatedUserId: `user_PRIVATE_ACCOUNT_${i}` }));
    const report = await runLoadStage(identities, { ...options, fetchFn, durationMs: 1_000, burst: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new Set(fetchFn.mock.calls.map(([, init]) => JSON.parse(init.body as string).chatId)).size).toBe(3);
    expect(report.total.successfulModelAnswers).toBe(3);
    expect(report.peakInFlight).toBe(3);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(JSON.stringify(report)).not.toContain("authenticatedUserId");
  });

  it("haelt pro Identitaet nur eine Frage offen und misst auslaufende Antworten", async () => {
    vi.useFakeTimers();
    const active = new Set<string>();
    const fetchFn = vi.fn<FetchLike>(async (_url, init) => {
      const chatId = JSON.parse(init.body as string).chatId as string;
      expect(active.has(chatId)).toBe(false);
      active.add(chatId);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active.delete(chatId);
      return ndjson([text, completed]);
    });
    const pending = runLoadStage([{ ...prepared }], {
      ...options, fetchFn, now: () => Date.now(), durationMs: 50, burst: false,
    });
    await vi.advanceTimersByTimeAsync(100);
    const report = await pending;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(report.total.elapsedMs).toBe(80);
    expect(report.total.ratesPerMinute.requests).toBe(1_500);
    expect(report.peakInFlight).toBe(1);
  });
});
