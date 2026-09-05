/** Chat-Protokollmessung: Cookies, Fragen und Antworten gelangen nie in Berichte. */
export const LOAD_STAGES = [100, 250, 500, 1_000] as const;
export const LOAD_PHASES = ["queued", "retrieval", "sql", "graph", "generating", "saving"] as const;
export type ScenarioType = "vector" | "sql" | "graph";
export type LoadPhase = (typeof LOAD_PHASES)[number];
export type LoadScenario = { type: ScenarioType; question: string; collectionIds?: string[] };
export type LoadIdentity = { id: string; cookie: string; scenarios: LoadScenario[] };
export type LoadFixture = { identities: LoadIdentity[] };
export type PreparedChat = { chatId: string; authenticatedUserId: string };
export type PreparedIdentity = PreparedChat & { identity: LoadIdentity };
export type LoadFailure = "http" | "stream" | "incomplete_stream" | "empty_answer" | "protocol" | "timeout" | "aborted" | "network";
export type LoadMeasurement = {
  scenario: ScenarioType;
  httpStatus: number;
  success: boolean;
  failure: LoadFailure | null;
  doneStatus: "completed" | "failed" | "aborted" | null;
  modelInvoked: boolean | null;
  hasText: boolean;
  firstTextMs: number | null;
  firstStatusMs: number | null;
  phaseMs: Partial<Record<LoadPhase, number>>;
  totalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type RequestOptions = {
  url: string; timeoutMs: number; signal?: AbortSignal; fetchFn?: FetchLike; now?: () => number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateFixture(value: unknown, requiredIdentities: number): LoadFixture {
  const identities = object(value)?.identities;
  if (!Array.isArray(identities) || identities.length < requiredIdentities) {
    throw new Error(`Die Fixture braucht mindestens ${requiredIdentities} getrennte Identitaeten.`);
  }
  const ids = new Set<string>();
  const cookies = new Set<string>();
  return {
    identities: identities.map((entry, index) => {
      const identity = object(entry);
      const at = `Identitaet ${index + 1}`;
      if (!identity || typeof identity.id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(identity.id)) {
        throw new Error(`${at}: id muss eine kurze, neutrale Kennung sein.`);
      }
      if (ids.has(identity.id)) throw new Error(`${at}: doppelte Kennung.`);
      ids.add(identity.id);
      if (typeof identity.cookie !== "string" || !identity.cookie.trim() ||
        identity.cookie.length > 32_768 || /[^\x20-\x7e]/.test(identity.cookie)) {
        throw new Error(`${at}: ungueltiger Cookie-Header.`);
      }
      const cookie = identity.cookie.trim();
      if (cookies.has(cookie)) throw new Error(`${at}: ein Cookie darf nur einer Identitaet gehoeren.`);
      cookies.add(cookie);
      if (!Array.isArray(identity.scenarios) || !identity.scenarios.length || identity.scenarios.length > 100) {
        throw new Error(`${at}: 1 bis 100 Szenarien erforderlich.`);
      }
      const scenarios = identity.scenarios.map((entry, scenarioIndex): LoadScenario => {
        const scenario = object(entry);
        const location = `${at}, Szenario ${scenarioIndex + 1}`;
        if (!scenario || !["vector", "sql", "graph"].includes(String(scenario.type))) {
          throw new Error(`${location}: type muss vector, sql oder graph sein.`);
        }
        if (typeof scenario.question !== "string" || !scenario.question.trim() || scenario.question.length > 2_000) {
          throw new Error(`${location}: question muss 1 bis 2.000 Zeichen enthalten.`);
        }
        if (scenario.collectionIds !== undefined && (!Array.isArray(scenario.collectionIds) ||
          !scenario.collectionIds.length || scenario.collectionIds.length > 100 ||
          scenario.collectionIds.some((id) => typeof id !== "string" || !UUID.test(id)))) {
          throw new Error(`${location}: collectionIds muss gueltige Sammlungs-UUIDs enthalten.`);
        }
        return {
          type: scenario.type as ScenarioType, question: scenario.question.trim(),
          ...(scenario.collectionIds ? { collectionIds: [...scenario.collectionIds] as string[] } : {}),
        };
      });
      return { id: identity.id, cookie, scenarios };
    }),
  };
}

export function validateTarget(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--url muss eine HTTP(S)-Origin sein."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/") {
    throw new Error("--url muss eine HTTP(S)-Origin ohne Zugangsdaten, Pfad oder Query sein.");
  }
  return url.origin;
}

export function validateStages(value: string): number[] {
  const stages = value.split(",").map(Number);
  if (!stages.length || stages.some((stage, i) =>
    !LOAD_STAGES.includes(stage as (typeof LOAD_STAGES)[number]) || (i > 0 && stage <= stages[i - 1])
  )) throw new Error("--stages: aufsteigende Auswahl aus 100,250,500,1000 erforderlich.");
  return stages;
}

function boundedRequest(options: RequestOptions) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300_000) {
    throw new Error("timeoutMs muss zwischen 1 und 300000 liegen.");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
  return { signal, timedOut: () => timeout.signal.aborted, dispose: () => clearTimeout(timer) };
}

/** Die Chat-Anlagen werden getrennt gemessen und zaehlen nicht als Antworten. */
export async function createLoadChat(identity: LoadIdentity, options: RequestOptions): Promise<PreparedChat> {
  const bounded = boundedRequest(options);
  try {
    const response = await (options.fetchFn ?? fetch)(`${options.url}/api/chats`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: identity.cookie },
      body: JSON.stringify({ titel: "Lasttest" }), redirect: "manual", signal: bounded.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Chat-Vorbereitung fehlgeschlagen (HTTP ${response.status}).`);
    }
    const body = object(await response.json());
    const chat = object(body?.chat);
    if (typeof chat?.id !== "string" || !UUID.test(chat.id)) {
      throw new Error("Chat-Vorbereitung lieferte keine gueltige Chat-ID.");
    }
    return { chatId: chat.id, authenticatedUserId: parseAuthenticatedUserId(body?.authenticatedUserId) };
  } catch (error) {
    if (bounded.signal.aborted) throw new Error("Chat-Vorbereitung abgebrochen oder Zeitlimit erreicht.");
    if (error instanceof Error && error.message.startsWith("Chat-Vorbereitung")) throw error;
    throw new Error("Chat-Vorbereitung fehlgeschlagen (Netzwerk oder Antwortformat).");
  } finally { bounded.dispose(); }
}

function parseAuthenticatedUserId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) {
    throw new Error("Chat-Vorbereitung lieferte keine gueltige authentifizierte Konto-ID. Serverversion pruefen.");
  }
  return value;
}

/** Nur die serverseitig bestaetigte Identitaet zaehlt; keine IDs in Fehlermeldungen. */
export function registerAuthenticatedUser(seen: Set<string>, value: unknown): void {
  const userId = parseAuthenticatedUserId(value);
  if (seen.has(userId)) {
    throw new Error("Chat-Vorbereitung abgebrochen: Mehrere Sitzungen gehoeren zum selben Konto. Fuer jeden Nutzer ist ein getrenntes Testkonto erforderlich.");
  }
  seen.add(userId);
}

class ProtocolError extends Error {}
const MAX_EVENT_CHARACTERS = 1_048_576;

/** Keine Retries: Wiederholungen wuerden die gemessene Last veraendern. */
export async function measureQuestion(
  prepared: PreparedIdentity, scenario: LoadScenario, options: RequestOptions,
): Promise<LoadMeasurement> {
  const now = options.now ?? (() => performance.now());
  const start = now();
  const bounded = boundedRequest(options);
  const result: LoadMeasurement = {
    scenario: scenario.type, httpStatus: 0, success: false, failure: null,
    doneStatus: null, modelInvoked: null, hasText: false, firstTextMs: null,
    firstStatusMs: null, phaseMs: {}, totalMs: 0, inputTokens: null, outputTokens: null,
  };
  let activePhase: LoadPhase | null = null;
  let phaseStarted = start;
  let sawDone = false;
  let sawStreamError = false;
  const closePhase = (at: number) => {
    if (activePhase) result.phaseMs[activePhase] = (result.phaseMs[activePhase] ?? 0) + at - phaseStarted;
    activePhase = null;
  };
  const event = (line: string) => {
    if (!line.trim()) return;
    if (line.length > MAX_EVENT_CHARACTERS) throw new ProtocolError();
    let data: Record<string, unknown> | null;
    try { data = object(JSON.parse(line)); } catch { throw new ProtocolError(); }
    if (!data || typeof data.type !== "string") throw new ProtocolError();
    const at = now();
    if (data.type === "error") sawStreamError = true;
    if (data.type === "status") {
      result.firstStatusMs ??= at - start;
      if (LOAD_PHASES.includes(data.phase as LoadPhase) && data.phase !== activePhase) {
        closePhase(at);
        activePhase = data.phase as LoadPhase;
        phaseStarted = at;
      }
    }
    if (data.type === "text" && typeof data.delta === "string" && data.delta.trim()) {
      result.hasText = true;
      result.firstTextMs ??= at - start;
    }
    if (data.type === "done") {
      if (sawDone || !["completed", "failed", "aborted"].includes(String(data.status)) ||
        typeof data.modelInvoked !== "boolean") throw new ProtocolError();
      sawDone = true;
      result.doneStatus = data.status as LoadMeasurement["doneStatus"];
      result.modelInvoked = data.modelInvoked;
      const usage = object(data.usage);
      for (const key of ["inputTokens", "outputTokens"] as const) {
        const value = usage?.[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
      }
      closePhase(at);
    }
  };
  try {
    const response = await (options.fetchFn ?? fetch)(`${options.url}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: prepared.identity.cookie },
      body: JSON.stringify({
        chatId: prepared.chatId, requestId: crypto.randomUUID(), question: scenario.question,
        ...(scenario.collectionIds ? { collectionIds: scenario.collectionIds } : {}),
      }),
      redirect: "manual", signal: bounded.signal,
    });
    result.httpStatus = response.status;
    if (!response.ok) {
      result.failure = "http";
      await response.body?.cancel();
      return result;
    }
    if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      await response.body?.cancel();
      throw new ProtocolError();
    }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    bounded.signal.addEventListener("abort", abort, { once: true });
    if (bounded.signal.aborted) abort();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (bounded.signal.aborted) throw new Error("aborted");
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) event(line);
        if (buffer.length > MAX_EVENT_CHARACTERS) throw new ProtocolError();
        if (done) { if (buffer.trim()) event(buffer); break; }
      }
    } finally {
      bounded.signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    result.failure = sawStreamError || (sawDone && result.doneStatus !== "completed") ? "stream"
      : !sawDone ? "incomplete_stream" : !result.hasText ? "empty_answer" : null;
    result.success = result.failure === null;
  } catch (error) {
    result.failure = bounded.signal.aborted ? (bounded.timedOut() ? "timeout" : "aborted")
      : error instanceof ProtocolError ? "protocol" : "network";
  } finally {
    closePhase(now());
    result.totalMs = now() - start;
    bounded.dispose();
  }
  return result;
}

export function percentiles(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

export function summarizeMeasurements(results: LoadMeasurement[], elapsedMs: number) {
  const successes = results.filter((r) => r.success);
  const modelAnswers = successes.filter((r) => r.modelInvoked && r.hasText);
  const perMinute = (count: number) => elapsedMs > 0 ? count * 60_000 / elapsedMs : 0;
  const present = (values: (number | null | undefined)[]) => values.filter((v): v is number => v != null);
  const httpStatuses: Record<string, number> = {};
  const failures: Partial<Record<LoadFailure, number>> = {};
  const doneStatuses: Record<string, number> = {};
  for (const result of results) {
    httpStatuses[result.httpStatus] = (httpStatuses[result.httpStatus] ?? 0) + 1;
    if (result.failure) failures[result.failure] = (failures[result.failure] ?? 0) + 1;
    const status = result.doneStatus ?? "missing";
    doneStatuses[status] = (doneStatuses[status] ?? 0) + 1;
  }
  return {
    elapsedMs, requests: results.length, successfulAnswers: successes.length,
    successfulModelAnswers: modelAnswers.length,
    successfulWithoutModel: successes.filter((r) => r.modelInvoked === false).length,
    failures, httpStatuses, doneStatuses,
    ratesPerMinute: { requests: perMinute(results.length), successfulAnswers: perMinute(successes.length), successfulModelAnswers: perMinute(modelAnswers.length) },
    timingsMs: {
      firstTextSuccessful: percentiles(present(successes.map((r) => r.firstTextMs))),
      firstModelTextSuccessful: percentiles(present(modelAnswers.map((r) => r.firstTextMs))),
      firstStatus: percentiles(present(results.map((r) => r.firstStatusMs))),
      total: percentiles(results.map((r) => r.totalMs)),
      totalSuccessful: percentiles(successes.map((r) => r.totalMs)),
      phases: Object.fromEntries(LOAD_PHASES.map((phase) => [phase, percentiles(present(results.map((r) => r.phaseMs[phase])))])),
    },
    modelTokens: {
      input: modelAnswers.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      output: modelAnswers.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
      answersWithOutputUsage: modelAnswers.filter((r) => r.outputTokens !== null).length,
    },
  };
}

export function reportStage(results: LoadMeasurement[], elapsedMs: number) {
  return {
    total: summarizeMeasurements(results, elapsedMs),
    byScenario: Object.fromEntries((["vector", "sql", "graph"] as const).map((type) => [
      type, summarizeMeasurements(results.filter((r) => r.scenario === type), elapsedMs),
    ])),
  };
}

/** Ein Slot gehoert genau einer Identitaet; pro Slot laeuft nur eine Frage. */
export async function runLoadStage(
  identities: PreparedIdentity[],
  options: RequestOptions & { durationMs: number; burst: boolean; scenarioOffset?: number },
) {
  if (!identities.length || !Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw new Error("Die Laststufe braucht Identitaeten und eine positive Dauer.");
  }
  const authenticatedUsers = new Set<string>();
  for (const identity of identities) registerAuthenticatedUser(authenticatedUsers, identity.authenticatedUserId);
  const now = options.now ?? (() => performance.now());
  const started = now();
  const deadline = started + options.durationMs;
  const results: LoadMeasurement[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  await Promise.all(identities.map(async (identity, index) => {
    let turn = 0;
    do {
      if (options.signal?.aborted || now() >= deadline) break;
      const scenarios = identity.identity.scenarios;
      const scenario = scenarios[(index + turn + (options.scenarioOffset ?? 0)) % scenarios.length];
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try { results.push(await measureQuestion(identity, scenario, options)); }
      finally { inFlight -= 1; }
      turn += 1;
    } while (!options.burst && now() < deadline);
  }));
  return {
    concurrency: identities.length, peakInFlight, mode: options.burst ? "burst" : "sustained",
    scheduledDurationMs: options.burst ? null : options.durationMs,
    ...reportStage(results, now() - started),
  };
}
