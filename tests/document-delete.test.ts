import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), document: vi.fn(), collection: vi.fn(), list: vi.fn(),
  storage: vi.fn(), blob: vi.fn(), remove: vi.fn(), acquire: vi.fn(),
  eval: vi.fn(), zrem: vi.fn(async () => 1),
}));
vi.mock("@/lib/auth/user", () => ({
  requireKontext: mocks.auth,
  NotSignedInError: class extends Error {}, NotAdminError: class extends Error {},
}));
vi.mock("@/lib/collections", () => ({ ladeSammlung: mocks.collection }));
vi.mock("@/lib/documents", () => ({
  ladeDokument: mocks.document, ladeDokumenteDerSammlung: mocks.list,
  loescheDatei: mocks.blob, entferneDokumentSatz: mocks.remove,
}));
vi.mock("@/lib/ingest", () => ({ entferneDokumentJeTyp: mocks.storage }));
vi.mock("@vercel/blob", () => ({ del: mocks.blob }));
vi.mock("@/lib/ratelimit", async (original) => {
  const actual = await original<typeof import("@/lib/ratelimit")>();
  return {
    ...actual, getRedis: () => ({ eval: mocks.eval, zrem: mocks.zrem }),
    erwirbSperre: mocks.acquire,
    gibSperreFrei: async (key: string, owner: string) => { await mocks.eval(actual.RELEASE_LOCK_SCRIPT, [key], [owner]); },
  };
});
import { DELETE } from "@/app/api/documents/[id]/route";
import { ingestionSignal, pause } from "@/lib/capacity";
import { NotFoundError } from "@/lib/errors";
import { RELEASE_LOCK_SCRIPT, RENEW_LOCK_SCRIPT } from "@/lib/ratelimit";

const context = { params: Promise.resolve({ id: "doc-1" }) };
const document = { id: "doc-1", collectionId: "collection-1", userId: "user-1", status: "fertig", pageCount: 1, chunkCount: 3, blobPath: "private/doc-1", filename: "script.cypher" };
let owner: string | undefined;
function request(signal?: AbortSignal) { return new Request("https://app.invalid/api/documents/doc-1", { method: "DELETE", signal }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.resetAllMocks(); owner = undefined;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-only-token");
  mocks.auth.mockResolvedValue({ userId: "user-1" });
  mocks.document.mockResolvedValue(document);
  mocks.collection.mockResolvedValue({ id: "collection-1", kind: "graph" });
  mocks.list.mockImplementation(async () => { expect(owner).toBeTruthy(); return [document, { id: "other-ready", status: "fertig" }, { id: "other-running", status: "laeuft" }]; });
  mocks.acquire.mockImplementation(async (_key: string, next: string) => {
    if (owner) return false;
    owner = next; return true;
  });
  mocks.eval.mockImplementation(async (script: string, _keys: string[], args: unknown[]) => {
    if (script === RELEASE_LOCK_SCRIPT) { if (owner !== args[0]) return 0; owner = undefined; return 1; }
    if (script === RENEW_LOCK_SCRIPT) return owner === args[0] ? 1 : 0;
    return 1;
  });
  mocks.storage.mockImplementation(async () => { expect(owner).toBeTruthy(); });
  mocks.blob.mockImplementation(async () => { expect(owner).toBeTruthy(); });
  mocks.remove.mockImplementation(async () => { expect(owner).toBeTruthy(); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("serialized document deletion", () => {
  it.each(["sql", "graph"])("re-reads %s readiness under lock and protects storage, original file and metadata until completion", async (kind) => {
    mocks.collection.mockResolvedValue({ id: "collection-1", kind });
    mocks.document.mockResolvedValueOnce({ ...document, status: "laeuft", chunkCount: 0 });
    const response = await DELETE(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.document).toHaveBeenCalledTimes(2);
    expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.document.mock.invocationCallOrder[1]);
    expect(mocks.storage).toHaveBeenCalledWith(expect.objectContaining({
      kind, satz: document,
      uebrige: kind === "graph" ? [{ id: "other-ready", status: "fertig" }] : [],
    }));
    expect(mocks.storage.mock.invocationCallOrder[0]).toBeLessThan(mocks.blob.mock.invocationCallOrder[0]);
    expect(mocks.blob.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]);
    expect(mocks.blob).toHaveBeenCalledWith(document.blobPath, { token: "test-only-token", abortSignal: expect.any(AbortSignal) });
    const releaseIndex = mocks.eval.mock.calls.findIndex(([script]) => script === RELEASE_LOCK_SCRIPT);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.eval.mock.invocationCallOrder[releaseIndex]);
    expect(owner).toBeUndefined();
  });

  it("uses a distinct owner for repeated deletion requests", async () => {
    expect((await DELETE(request(), context)).status).toBe(200);
    expect((await DELETE(request(), context)).status).toBe(200);
    expect(mocks.acquire.mock.calls[0][1]).not.toBe(mocks.acquire.mock.calls[1][1]);
  });

  it("stops before storage changes when the document disappeared while waiting", async () => {
    mocks.document.mockResolvedValueOnce(document).mockRejectedValueOnce(new NotFoundError("Das Dokument"));
    expect((await DELETE(request(), context)).status).toBe(404);
    expect(mocks.storage).not.toHaveBeenCalled();
    expect(mocks.blob).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(owner).toBeUndefined();
  });

  it.each(["storage", "blob"] as const)("does not delete metadata after cancellation in %s", async (stage) => {
    const controller = new AbortController();
    mocks[stage].mockImplementation(async () => { controller.abort(); });
    expect((await DELETE(request(controller.signal), context)).status).toBe(499);
    expect(mocks.remove).not.toHaveBeenCalled();
    if (stage === "storage") expect(mocks.blob).not.toHaveBeenCalled();
    expect(owner).toBeUndefined();
  });

  it("cannot release a replacement owner and does not delete metadata after losing its lease", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    mocks.storage.mockImplementation(async () => { started(); await pause(70_000, ingestionSignal()); });
    const running = DELETE(request(), context);
    await begun;
    owner = "replacement-owner";
    await vi.advanceTimersByTimeAsync(60_001);
    const response = await running;
    expect(response.status).toBe(503);
    expect(owner).toBe("replacement-owner");
    expect(mocks.blob).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.eval).toHaveBeenCalledWith(RELEASE_LOCK_SCRIPT, expect.any(Array), [mocks.acquire.mock.calls[0][1]]);
  });

  it("propagates its 90-second deadline before metadata cleanup", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    mocks.storage.mockImplementation(async () => { deadline.abort(new DOMException("Deadline", "TimeoutError")); });
    expect((await DELETE(request(), context)).status).toBe(504);
    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(mocks.blob).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(owner).toBeUndefined();
  });
});
