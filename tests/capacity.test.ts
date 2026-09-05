import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACQUIRE_SCRIPT, RENEW_SCRIPT, MODEL_BUDGET_SCRIPT, modelLimits, positiveSetting, pause } from "@/lib/capacity";
import { AnswerBudget, chatRequestSchema, tokenBound } from "@/lib/chat-contract";
import { RELEASE_LOCK_SCRIPT, RENEW_LOCK_SCRIPT } from "@/lib/ratelimit";

afterEach(() => vi.unstubAllEnvs());
describe("Capacity configuration and answer budgets", () => {
  it("grants detailed answers a larger output allowance", () => {
    expect(new AnswerBudget("compact").reserve(100)).toBe(1200);
    expect(new AnswerBudget("detailed").reserve(100)).toBe(2400);
  });
  it("fails closed for invalid concurrency settings", () => {
    vi.stubEnv("CHAT_MAX_CONCURRENT", "NaN");
    expect(() => positiveSetting("CHAT_MAX_CONCURRENT", 1000)).toThrow();
  });
  it("uses model-specific limits without ignoring malformed entries", () => {
    vi.stubEnv("MODEL_CAPACITY_JSON", '{"test/model":{"rpm":60,"tpm":100000}}');
    expect(modelLimits("test/model")).toEqual({ rpm: 60, tpm: 100000 });
    vi.stubEnv("MODEL_CAPACITY_JSON", '{"test/model":{"rpm":0,"tpm":100000}}');
    expect(() => modelLimits("test/model")).toThrow();
  });
  it("cancels waiting immediately", async () => {
    const controller = new AbortController();
    const waiting = pause(5000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
  it("accounts for every model step including fallback", () => {
    const budget = new AnswerBudget("compact");
    budget.reserve(30_000);
    budget.reserve(30_000);
    budget.reserve(30_000);
    expect(() => budget.reserve(30_000)).toThrow(/Antwortbudget/);
    expect(() => new AnswerBudget("compact").reserve(100_000)).toThrow();
  });
  it("caps cumulative output across steps", () => {
    const budget = new AnswerBudget("compact");
    budget.output = 2350;
    expect(budget.reserve(100)).toBe(50);
    budget.output = 2400;
    expect(() => budget.reserve(100)).toThrow();
  });
  it("counts non-ASCII bytes conservatively and validates bounded input", () => {
    expect(tokenBound("ä🙂")).toBe(6);
    expect(chatRequestSchema.safeParse({ chatId: "x", requestId: "x", question: "test" }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ chatId: crypto.randomUUID(), requestId: crypto.randomUUID(), question: "x".repeat(2001) }).success).toBe(false);
  });
});

// Only a dedicated disposable local Redis is used. Never takes production credentials.
const socket = process.env.REDIS_TEST_SOCKET;
const cli = promisify(execFile);
async function redis(...args: string[]): Promise<string> {
  const { stdout } = await cli(process.env.REDIS_CLI ?? "redis-cli", ["-s", socket!, "--raw", ...args]);
  if (/^(ERR|error)/i.test(stdout)) throw new Error(stdout);
  return stdout.trim();
}
describe.skipIf(!socket)("Atomic Lua scripts against disposable Redis", () => {
  it("never admits more simultaneous work than configured", async () => {
    const prefix = `test:${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => redis("EVAL", ACQUIRE_SCRIPT, "2", `${prefix}:a`, `${prefix}:q`, `r${i}`, "7", "100", "5000", "300000")));
    expect(results.filter(r => r === "1")).toHaveLength(7);
    expect(await redis("ZCARD", `${prefix}:a`)).toBe("7");
  });
  it("enforces FIFO and rejects a full queue", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const acquire = (id: string) => redis("EVAL", ACQUIRE_SCRIPT, "2", `${p}:a`, `${p}:q`, id, "1", "1", "5000", "300000");
    expect(await acquire("active")).toBe("1");
    expect(await acquire("first")).toBe("0");
    expect(await acquire("second")).toBe("-1");
    await redis("ZREM", `${p}:a`, "active");
    expect(await acquire("second")).toBe("-1");
    expect(await acquire("first")).toBe("1");
  });
  it("recovers expired leases", async () => {
    const p = `test:${crypto.randomUUID()}`;
    await redis("ZADD", `${p}:a`, "1", "crashed");
    expect(await redis("EVAL", ACQUIRE_SCRIPT, "2", `${p}:a`, `${p}:q`, "new", "1", "1", "5000", "300000")).toBe("1");
  });
  it("renews a live owner but never resurrects an expired or released lease", async () => {
    const key = `test:${crypto.randomUUID()}:active`;
    await redis("ZADD", key, String(Date.now() + 10_000), "live", "1", "expired");
    expect(await redis("EVAL", RENEW_SCRIPT, "1", key, "live", "300000")).toBe("1");
    expect(Number(await redis("ZSCORE", key, "live"))).toBeGreaterThan(Date.now() + 290_000);
    expect(await redis("EVAL", RENEW_SCRIPT, "1", key, "expired", "300000")).toBe("0");
    await redis("ZREM", key, "live");
    expect(await redis("EVAL", RENEW_SCRIPT, "1", key, "live", "300000")).toBe("0");
  });
  it("an expired collection owner cannot renew or release a replacement lock", async () => {
    const key = `test:${crypto.randomUUID()}:lock`;
    await redis("SET", key, "expired-owner", "PX", "1");
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await redis("EVAL", RENEW_LOCK_SCRIPT, "1", key, "expired-owner", "120000")).toBe("0");
    await redis("SET", key, "new-attempt", "PX", "120000");
    expect(await redis("EVAL", RENEW_LOCK_SCRIPT, "1", key, "expired-owner", "120000")).toBe("0");
    expect(await redis("EVAL", RELEASE_LOCK_SCRIPT, "1", key, "expired-owner")).toBe("0");
    expect(await redis("GET", key)).toBe("new-attempt");
    expect(await redis("EVAL", RENEW_LOCK_SCRIPT, "1", key, "new-attempt", "120000")).toBe("1");
    expect(await redis("EVAL", RELEASE_LOCK_SCRIPT, "1", key, "new-attempt")).toBe("1");
  });
  it("atomically reserves RPM and TPM and expires old reservations", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const reserve = (id: string, n: number) => redis("EVAL", MODEL_BUDGET_SCRIPT, "2", `${p}:calls`, `${p}:tokens`, id, "2", String(n), "500");
    expect(await reserve("first", 400)).toBe("1");
    expect(await reserve("large", 101)).toBe("0");
    expect(await reserve("second", 100)).toBe("1");
    expect(await reserve("third", 1)).toBe("0");
    await redis("ZADD", `${p}:calls`, "1", "first");
    expect(await reserve("after-expiry", 400)).toBe("1");
  });
});
