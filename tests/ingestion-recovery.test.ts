import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(), zrem: vi.fn(async () => 1), acquire: vi.fn(), release: vi.fn(),
  list: vi.fn(), read: vi.fn(), finish: vi.fn(), remove: vi.fn(), deleteFile: vi.fn(),
  importStatements: vi.fn(), deleteGraph: vi.fn(), sql: vi.fn(),
}));
vi.mock("@/lib/ratelimit", async (original) => ({
  ...await original<typeof import("@/lib/ratelimit")>(),
  getRedis: () => ({ eval: mocks.eval, zrem: mocks.zrem }),
  erwirbSperre: mocks.acquire, gibSperreFrei: mocks.release,
}));
vi.mock("@/lib/documents", async (original) => ({
  ...await original<typeof import("@/lib/documents")>(),
  ladeDokumenteDerSammlung: mocks.list, leseDatei: mocks.read,
  schliesseDokumentAb: mocks.finish, entferneDokumentSatz: mocks.remove, loescheDatei: mocks.deleteFile,
}));
vi.mock("@/lib/collections", async (original) => ({
  ...await original<typeof import("@/lib/collections")>(), setzeSammlungsSchema: vi.fn(async () => undefined),
}));
vi.mock("@/lib/graphstore", () => ({
  importStatements: mocks.importStatements, deleteGraph: mocks.deleteGraph,
  describeGraph: async () => ({ kind: "graph", nodes: 1, relationships: 0, labels: [], relationshipTypes: [], propertyKeys: [] }),
}));
vi.mock("@/lib/ingest", async (original) => ({
  ...await original<typeof import("@/lib/ingest")>(), ingestSql: mocks.sql,
}));
import { RENEW_SCRIPT, ingestionSignal, pause } from "@/lib/capacity";
import { verarbeiteGraph, verarbeiteTabelle } from "@/workflows/ingest";

const prep = {
  userId: "user_a", collectionId: "collection_a", filename: "new.cypher",
  contentType: "text/plain", blobPath: "new-script", kind: "graph" as const,
  verarbeitung: { label: "test", angepasst: false, zielGroesse: 1000, ueberlappung: 100 },
  sizeClassId: "test", maxPagesPerDocument: 100, maxTotalPages: 1000,
  seitenBisher: 0, sammlungsName: "Test",
} as Parameters<typeof verarbeiteGraph>[1];
let records: DocumentRecord[];
let graph: string[];
let owner: string | undefined;
const scripts = new Map<string, string>();
function record(id: string, status: DocumentRecord["status"] = "fertig"): DocumentRecord {
  return {
    id, userId: prep.userId, collectionId: prep.collectionId, filename: `${id}.cypher`,
    blobPath: `${id}-script`, contentType: "text/plain", sizeBytes: 10,
    pageCount: status === "fertig" ? 1 : 0, chunkCount: status === "fertig" ? 1 : 0,
    status, error: null, workflowRunId: null,
    uploadedAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks();
  records = [record("old"), record("new", "laeuft")]; graph = []; owner = undefined;
  scripts.clear(); scripts.set("old-script", "CREATE (:Old)");
  scripts.set("new-script", "CREATE (:NewFirst); CREATE (:NewSecond)");
  mocks.eval.mockReset().mockResolvedValue(1);
  mocks.acquire.mockImplementation(async (_key: string, nextOwner: string) => {
    if (owner) return false;
    owner = nextOwner; return true;
  });
  mocks.release.mockImplementation(async (_key: string, oldOwner: string) => {
    if (owner === oldOwner) owner = undefined;
  });
  mocks.list.mockImplementation(async () => records.map((entry) => ({ ...entry })));
  mocks.read.mockImplementation(async (path: string) => {
    const script = scripts.get(path);
    return script === undefined ? null : new Blob([script]).stream();
  });
  mocks.finish.mockImplementation(async (id: string, _collection: string, pages: number, chunks: number) => {
    expect(owner).toEqual(expect.any(String));
    const entry = records.find((record) => record.id === id)!;
    entry.status = "fertig"; entry.pageCount = pages; entry.chunkCount = chunks;
  });
  mocks.deleteGraph.mockImplementation(async () => { expect(owner).toBeTruthy(); graph = []; });
  mocks.importStatements.mockImplementation(async (_collection: string, statements: string[]) => { graph.push(...statements); });
  mocks.sql.mockReset().mockResolvedValue({ units: 4, pageCount: 1, schema: {}, replacedTable: "new" });
  mocks.remove.mockReset(); mocks.deleteFile.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("serialized import recovery", () => {
  it("rebuilds partial graph work under a fresh owner and preserves all subsequently completed scripts", async () => {
    mocks.eval.mockImplementation(async (script: string) => script === RENEW_SCRIPT ? 0 : 1);
    let interrupt = true;
    let started!: () => void;
    const partialImport = new Promise<void>((resolve) => { started = resolve; });
    mocks.importStatements.mockImplementation(async (_collection: string, statements: string[]) => {
      if (interrupt && statements[0]?.includes("NewFirst")) {
        graph.push(statements[0]);
        started();
        await pause(65_000, ingestionSignal());
      }
      graph.push(...statements);
    });
    const first = expect(verarbeiteGraph("new", prep)).rejects.toThrow("Verarbeitungskapazitaet");
    await partialImport;
    await vi.advanceTimersByTimeAsync(60_001); await first;
    expect(graph).toEqual(["CREATE (:Old)", "CREATE (:NewFirst)"]);
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(owner).toBeUndefined();

    // Another successful owner can commit before this interrupted step retries.
    records.push(record("between")); scripts.set("between-script", "CREATE (:Between)");
    graph.push("CREATE (:Between)");
    interrupt = false; mocks.eval.mockResolvedValue(1);
    await expect(verarbeiteGraph("new", prep)).resolves.toEqual({ seiten: 1, abschnitte: 2 });
    expect(graph).toEqual(["CREATE (:Old)", "CREATE (:Between)", "CREATE (:NewFirst)", "CREATE (:NewSecond)"]);
    expect(mocks.acquire.mock.calls[0][1]).not.toBe(mocks.acquire.mock.calls[1][1]);
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("new", prep.collectionId, 1, 2);
    expect(mocks.finish.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[1]);
    expect(owner).toBeUndefined();
  });

  it.each(["graph", "sql"] as const)("returns committed %s counts without reimporting after a lost step response", async (kind) => {
    records[1] = { ...records[1], status: "fertig", pageCount: 7, chunkCount: 19 };
    const work = kind === "graph" ? verarbeiteGraph : verarbeiteTabelle;
    await expect(work("new", prep)).resolves.toEqual({ seiten: 7, abschnitte: 19 });
    expect(mocks.deleteGraph).not.toHaveBeenCalled();
    expect(mocks.importStatements).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(owner).toBeUndefined();
  });

  it("commits SQL document readiness before releasing its collection lock", async () => {
    await expect(verarbeiteTabelle("new", { ...prep, filename: "new.csv", kind: "sql" })).resolves.toEqual({ seiten: 1, abschnitte: 4 });
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("new", prep.collectionId, 1, 4);
    expect(mocks.sql.mock.invocationCallOrder[0]).toBeLessThan(mocks.finish.mock.invocationCallOrder[0]);
    expect(mocks.finish.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
    expect(owner).toBeUndefined();
  });
});
