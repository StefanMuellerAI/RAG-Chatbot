import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRedis, gibSperreFrei, RENEW_LOCK_SCRIPT } from "./ratelimit";
import { RateLimitError } from "./errors";

export type WorkClass = "chat" | "sql" | "graph" | "retrieval" | "ingestion";
export type WorkOptions = { signal?: AbortSignal; onWait?: () => void; pool?: "chat" | "ingestion" };
export type CapacityLease = (() => Promise<void>) & { renew(): Promise<void>; expiresAt(): number };
export class CapacityLeaseLostError extends Error {
  constructor() { super("Die Verarbeitungskapazitaet konnte nicht verlaengert werden. Der Schritt wird erneut versucht."); }
}

async function boundedRenewal(operation: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CapacityLeaseLostError()), 5_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function positiveSetting(name: string, fallback: number, maximum = 100_000): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} muss eine ganze Zahl zwischen 1 und ${maximum} sein.`);
  }
  return value;
}

// Redis TIME avoids clock skew between function instances. The sorted wait set
// is FIFO; expirations recover capacity even after a process is killed.
export const ACQUIRE_SCRIPT = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now-tonumber(ARGV[4]))
if not redis.call('ZSCORE',KEYS[2],ARGV[1]) then
 if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) then return -1 end
 redis.call('ZADD',KEYS[2],now,ARGV[1])
end
local first=redis.call('ZRANGE',KEYS[2],0,0)
if first[1]==ARGV[1] and redis.call('ZCARD',KEYS[1])<tonumber(ARGV[2]) then
 redis.call('ZREM',KEYS[2],ARGV[1]); redis.call('ZADD',KEYS[1],now+tonumber(ARGV[5]),ARGV[1])
 redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[5])+1000); return 1
end
redis.call('PEXPIRE',KEYS[2],tonumber(ARGV[4])+1000); return 0`;

/** An expired/deleted lease can never be resurrected by a delayed heartbeat. */
export const RENEW_SCRIPT = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local expiry=redis.call('ZSCORE',KEYS[1],ARGV[1])
if not expiry or tonumber(expiry)<=now then return 0 end
redis.call('ZADD',KEYS[1],'XX',now+tonumber(ARGV[2]),ARGV[1])
redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[2])+1000); return 1`;

/** Rolling one-minute RPM/TPM reservations. Failed calls remain reserved. */
export const MODEL_BUDGET_SCRIPT = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local old=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now-60000)
local total=tonumber(redis.call('HGET',KEYS[2],'total') or '0')
for _,id in ipairs(old) do
 total=total-tonumber(redis.call('HGET',KEYS[2],id) or '0'); redis.call('HDEL',KEYS[2],id)
end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-60000)
redis.call('HSET',KEYS[2],'total',total)
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) or total+tonumber(ARGV[3])>tonumber(ARGV[4]) then return 0 end
redis.call('ZADD',KEYS[1],now,ARGV[1]); redis.call('HSET',KEYS[2],ARGV[1],ARGV[3],'total',total+tonumber(ARGV[3]))
redis.call('PEXPIRE',KEYS[1],120000); redis.call('PEXPIRE',KEYS[2],120000); return 1`;

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

const defaults: Record<WorkClass, number> = { chat: 1000, sql: 32, graph: 32, retrieval: 100, ingestion: 8 };

export async function acquireCapacity(kind: WorkClass, options: WorkOptions = {}): Promise<CapacityLease> {
  const limit = positiveSetting(`${kind.toUpperCase()}_MAX_CONCURRENT`, defaults[kind]);
  const queue = positiveSetting("CAPACITY_MAX_WAITERS", 1000);
  const waitMs = positiveSetting("CAPACITY_WAIT_MS", 5000, 30_000);
  // Chat is capped at 240s. Longer ingestion steps renew their own lease.
  const leaseMs = 300_000;
  const id = randomUUID();
  const keys = [`wa:capacity:{${kind}}:active`, `wa:capacity:{${kind}}:wait`];
  const redis = getRedis();
  let released = false;
  let expiresAt = 0;
  const release = async () => {
    if (released) return;
    released = true;
    await Promise.all(keys.map(key => redis.zrem(key, id)));
  };
  const lease = Object.assign(release, {
    expiresAt: () => expiresAt,
    renew: async () => {
      const start = Date.now();
      if (released || start >= expiresAt) throw new CapacityLeaseLostError();
      const renewed = await boundedRenewal(redis.eval(RENEW_SCRIPT, [keys[0]], [id, leaseMs]));
      if (renewed !== 1) throw new CapacityLeaseLostError();
      // Start time is conservative: network latency never extends our local lease.
      expiresAt = start + leaseMs;
    },
  });
  const end = Date.now() + waitMs;
  let announced = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const started = Date.now();
      const result = await redis.eval(ACQUIRE_SCRIPT, keys, [id, limit, queue, waitMs, leaseMs]);
      if (result === 1) { expiresAt = started + leaseMs; return lease; }
      if (result === -1 || Date.now() >= end) throw new RateLimitError(5);
      if (!announced) { options.onWait?.(); announced = true; }
      await pause(100 + Math.floor(Math.random() * 100), options.signal);
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

type IngestionContext = { signal: AbortSignal; checkpoint(): void };
const ingestionContext = new AsyncLocalStorage<IngestionContext & { locks: Set<CapacityLease> }>();

/** No-op outside an ingestion step; guards subsequent batches after lease loss. */
export function checkIngestionCapacity(): void { ingestionContext.getStore()?.checkpoint(); }
export function ingestionSignal(): AbortSignal | undefined {
  checkIngestionCapacity();
  return ingestionContext.getStore()?.signal;
}

/** Attach an already-acquired collection lock to the running step heartbeat. */
export function protectIngestionLock(key: string, owner: string, leaseMs: number, acquiredAt: number): () => Promise<void> {
  const context = ingestionContext.getStore();
  if (!context) throw new Error("Eine Verarbeitungssperre braucht eine aktive Ingestion-Kapazitaet.");
  let closed = false;
  let expiresAt = acquiredAt + leaseMs;
  const release = async () => {
    if (closed) return;
    closed = true;
    context.locks.delete(lock);
    await gibSperreFrei(key, owner);
  };
  const lock = Object.assign(release, {
    expiresAt: () => expiresAt,
    renew: async () => {
      if (closed) return;
      const start = Date.now();
      if (start >= expiresAt) throw new CapacityLeaseLostError();
      const renewed = await boundedRenewal(getRedis().eval(RENEW_LOCK_SCRIPT, [key], [owner, leaseMs]));
      if (closed) return;
      if (renewed !== 1) throw new CapacityLeaseLostError();
      expiresAt = start + leaseMs;
    },
  });
  context.locks.add(lock);
  return release;
}

/** Renew only while a real Node step is running, never while Workflow is suspended. */
export async function withIngestionCapacity<T>(work: (context: IngestionContext) => Promise<T>, options: WorkOptions = {}): Promise<T> {
  const duration = positiveSetting("INGESTION_MAX_STEP_MS", 900_000, 3_600_000);
  const lease = await acquireCapacity("ingestion", options);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const deadline = Date.now() + duration;
  const locks = new Set<CapacityLease>();
  const checkpoint = () => {
    // A graph write can run for 30 seconds. After an event-loop stall, do not
    // start one near lock expiry while a replacement owner could take over.
    const now = Date.now();
    if (now >= lease.expiresAt() || now >= deadline || [...locks].some(lock => now + 35_000 >= lock.expiresAt())) controller.abort(new CapacityLeaseLostError());
    signal.throwIfAborted();
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const heartbeat = () => {
    pending = (async () => {
      try { checkpoint(); await Promise.all([lease.renew(), ...[...locks].map(lock => lock.renew())]); checkpoint(); }
      catch { controller.abort(new CapacityLeaseLostError()); }
      if (!stopped && !signal.aborted) timer = setTimeout(heartbeat, 60_000);
    })();
  };
  timer = setTimeout(heartbeat, 60_000);
  const endTimer = setTimeout(() => controller.abort(new CapacityLeaseLostError()), Math.max(1, deadline - Date.now()));
  try {
    return await ingestionContext.run({ signal, checkpoint, locks }, async () => {
      checkpoint();
      try {
        const result = await work({ signal, checkpoint });
        checkpoint();
        return result;
      } catch (error) { checkpoint(); throw error; }
    });
  } finally {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(endTimer);
    await pending;
    for (const lock of locks) await lock();
    // Do not release on the first abort alone: still-running work must unwind first.
    await lease().catch(() => console.error("Kapazitaetsfreigabe fehlgeschlagen", { kind: "ingestion" }));
  }
}

export async function withCapacity<T>(kind: WorkClass, work: () => Promise<T>, options: WorkOptions = {}): Promise<T> {
  const release = await acquireCapacity(kind, options);
  try { options.signal?.throwIfAborted(); return await work(); }
  finally { await release().catch(() => console.error("Kapazitaetsfreigabe fehlgeschlagen", { kind })); }
}

export function modelLimits(model: string, pool: "chat" | "ingestion" = "chat"): { rpm: number; tpm: number } {
  const prefix = pool === "ingestion" ? "INGESTION_" : "";
  const defaults = {
    rpm: positiveSetting(`${prefix}MODEL_REQUESTS_PER_MINUTE`, pool === "ingestion" ? 30 : 120),
    tpm: positiveSetting(`${prefix}MODEL_TOKENS_PER_MINUTE`, pool === "ingestion" ? 100_000 : 1_000_000, 1_000_000_000),
  };
  const raw = process.env[`${prefix}MODEL_CAPACITY_JSON`];
  if (!raw) return defaults;
  const entry = JSON.parse(raw)[model];
  if (!entry) return defaults;
  if (![entry.rpm, entry.tpm].every(v => Number.isSafeInteger(v) && v > 0)) {
    throw new Error("MODEL_CAPACITY_JSON enthaelt ungueltige Budgets.");
  }
  return { rpm: entry.rpm, tpm: entry.tpm };
}

export async function reserveModelCall(model: string, tokens: number, options: WorkOptions = {}): Promise<void> {
  if (options.pool === "ingestion") {
    // Uploads have a smaller sub-budget AND count toward the shared provider cap.
    await reserveBudget(tokens, modelLimits(model, "ingestion"), `wa:model:ingestion:{${model}}`, options);
  }
  const limits = modelLimits(model);
  await reserveBudget(tokens, limits, `wa:model:{${model}}`, options);
}

async function reserveBudget(tokens: number, limits: { rpm: number; tpm: number }, prefix: string, options: WorkOptions): Promise<void> {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > limits.tpm) throw new RateLimitError(60);
  const keys = [`${prefix}:calls`, `${prefix}:tokens`];
  const end = Date.now() + positiveSetting("CAPACITY_WAIT_MS", 5000, 30_000);
  let announced = false;
  for (;;) {
    options.signal?.throwIfAborted();
    const ok = await getRedis().eval(MODEL_BUDGET_SCRIPT, keys, [randomUUID(), limits.rpm, tokens, limits.tpm]);
    if (ok === 1) return;
    if (Date.now() >= end) throw new RateLimitError(60);
    if (!announced) { options.onWait?.(); announced = true; }
    await pause(200 + Math.floor(Math.random() * 200), options.signal);
  }
}
