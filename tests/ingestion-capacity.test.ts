import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const redis = vi.hoisted(() => ({ eval: vi.fn(), zrem: vi.fn(async () => 1), unlock: vi.fn(async () => undefined) }));
const graphQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ratelimit", () => ({ getRedis: () => redis, gibSperreFrei: redis.unlock, RENEW_LOCK_SCRIPT: "renew-owner-lock" }));
vi.mock("falkordb", () => ({ FalkorDB: { connect: async () => ({ selectGraph: () => ({ query: graphQuery }) }) } }));
import { ACQUIRE_SCRIPT, RENEW_SCRIPT, checkIngestionCapacity, modelLimits, pause, protectIngestionLock, reserveModelCall, withIngestionCapacity } from "@/lib/capacity";
import { importStatements } from "@/lib/graphstore";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); redis.eval.mockReset().mockResolvedValue(1); redis.zrem.mockClear(); redis.unlock.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("renewing ingestion capacity", () => {
  it("renews throughout a long step and stops heartbeats after release", async () => {
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    const running = withIngestionCapacity(async () => { await gate; checkIngestionCapacity(); return 42; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(redis.eval.mock.calls.filter(([script]) => script === RENEW_SCRIPT)).toHaveLength(2);
    complete();
    await expect(running).resolves.toBe(42);
    expect(redis.zrem).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(redis.eval.mock.calls.filter(([script]) => script === RENEW_SCRIPT)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["missing", "redis-error", "redis-hung"])("fails closed on renewal %s before starting more work", async (failure) => {
    redis.eval.mockImplementation(async (script: string) => {
      if (script === ACQUIRE_SCRIPT) return 1;
      if (failure === "missing") return 0;
      if (failure === "redis-error") throw new Error("Redis unavailable");
      return new Promise(() => {});
    });
    const nextStage = vi.fn();
    const running = expect(withIngestionCapacity(async ({ signal }) => {
      await pause(120_000, signal);
      checkIngestionCapacity();
      nextStage();
    })).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(65_001);
    await running;
    expect(nextStage).not.toHaveBeenCalled();
    expect(redis.zrem).toHaveBeenCalledTimes(2);
  });

  it("detects expiry after an event-loop stall even before the heartbeat timer runs", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const write = vi.fn();
    const running = expect(withIngestionCapacity(async () => {
      await gate;
      checkIngestionCapacity();
      write();
    })).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(301_000);
    resume();
    await running;
    expect(write).not.toHaveBeenCalled();
    expect(redis.eval.mock.calls.filter(([script]) => script === RENEW_SCRIPT)).toHaveLength(0);
  });

  it("enforces an overall step deadline even when renewal succeeds", async () => {
    vi.stubEnv("INGESTION_MAX_STEP_MS", "70000");
    const running = expect(withIngestionCapacity(async ({ signal }) => pause(120_000, signal))).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(70_001);
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates settings before taking a lease", async () => {
    vi.stubEnv("INGESTION_MAX_STEP_MS", "invalid");
    await expect(withIngestionCapacity(async () => undefined)).rejects.toThrow("INGESTION_MAX_STEP_MS");
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("does not start a second real import statement after losing capacity", async () => {
    vi.stubEnv("FALKORDB_URL", "redis://example.invalid");
    redis.eval.mockImplementation(async (script: string) => script === RENEW_SCRIPT ? 0 : 1);
    graphQuery.mockReset().mockImplementation(async () => { await pause(61_000); return {}; });
    const running = expect(withIngestionCapacity(async () => importStatements("collection_1", ["CREATE (:First)", "CREATE (:Second)"]))).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(61_001);
    await running;
    expect(graphQuery).toHaveBeenCalledExactlyOnceWith("CREATE (:First)", { TIMEOUT: 30_000 });
  });

  it("renews the collection lock alongside capacity and releases only its attempt owner", async () => {
    const running = withIngestionCapacity(async ({ signal }) => {
      const release = protectIngestionLock("collection-lock", "unique-attempt", 120_000, Date.now());
      await pause(125_000, signal);
      checkIngestionCapacity();
      await release();
    });
    await vi.advanceTimersByTimeAsync(125_001);
    await running;
    expect(redis.eval.mock.calls.filter(([script]) => script === "renew-owner-lock")).toHaveLength(2);
    expect(redis.unlock).toHaveBeenCalledExactlyOnceWith("collection-lock", "unique-attempt");
  });

  it("stops when a collection lock loses ownership even if the capacity lease remains valid", async () => {
    redis.eval.mockImplementation(async (script: string) => script === "renew-owner-lock" ? 0 : 1);
    const write = vi.fn();
    const running = expect(withIngestionCapacity(async ({ signal }) => {
      protectIngestionLock("collection-lock", "old-attempt", 120_000, Date.now());
      await pause(125_000, signal);
      write();
    })).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(60_001);
    await running;
    expect(write).not.toHaveBeenCalled();
  });

  it.each([86_000, 121_000])("does not start a write near or after collection-lock expiry following an event-loop stall (%i ms)", async (now) => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const write = vi.fn();
    const running = expect(withIngestionCapacity(async () => {
      protectIngestionLock("collection-lock", "old-attempt", 120_000, Date.now());
      await gate;
      checkIngestionCapacity();
      write();
    })).rejects.toThrow("Verarbeitungskapazitaet");
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(now);
    resume();
    await running;
    expect(write).not.toHaveBeenCalled();
  });
});

describe("upload model sub-budgets", () => {
  it("reserves both the upload allocation and the shared provider budget", async () => {
    await reserveModelCall("test/model", 1000, { pool: "ingestion" });
    expect(redis.eval.mock.calls.map(([, keys]) => keys[0])).toEqual([
      "wa:model:ingestion:{test/model}:calls", "wa:model:{test/model}:calls",
    ]);
    expect(redis.eval.mock.calls[0][2]).toEqual([expect.any(String), 30, 1000, 100_000]);
  });

  it("allows a separate upload model override while preserving chat defaults", () => {
    vi.stubEnv("INGESTION_MODEL_CAPACITY_JSON", '{"test/model":{"rpm":5,"tpm":10000}}');
    expect(modelLimits("test/model", "ingestion")).toEqual({ rpm: 5, tpm: 10000 });
    expect(modelLimits("test/model")).toEqual({ rpm: 120, tpm: 1_000_000 });
  });
});
