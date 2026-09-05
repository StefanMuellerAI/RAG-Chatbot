import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { get, GetBlobResult } from "@vercel/blob";
import initSqlJs from "sql.js";
import { runSql } from "@/lib/sql-executor";
import { SqlExecutor } from "../services/sql/executor.mjs";
import { createSqlServer } from "../services/sql/server.mjs";

const collection = { userId: "user_1", id: "collection_1", sqlBlobPath: "files/user_1/collection_1/_db/sammlung.sqlite" };
const token = "test-token-only-012345678901234567890";
const endless = "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x";
const executors: SqlExecutor[] = [];
const executor = (options: ConstructorParameters<typeof SqlExecutor>[0] = {}) => {
  const service = new SqlExecutor({ blobGet: vi.fn<typeof get>().mockResolvedValue(null), ...options });
  executors.push(service);
  return service;
};
let bytes: Uint8Array;

beforeAll(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("CREATE TABLE records (n INTEGER)");
  for (let n = 0; n < 250; n++) db.run("INSERT INTO records VALUES (?)", [n]);
  bytes = db.export();
  db.close();
});

function blob(data = bytes, etag = '"v1"'): GetBlobResult {
  return {
    statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }),
    headers: new Headers(),
    blob: {
      url: "https://example.invalid/db", downloadUrl: "https://example.invalid/db",
      pathname: collection.sqlBlobPath, contentDisposition: "", cacheControl: "",
      uploadedAt: new Date(), etag, contentType: "application/vnd.sqlite3", size: data.byteLength,
    },
  };
}
function unchanged(etag = '"v1"'): GetBlobResult {
  const previous = blob();
  return { ...previous, statusCode: 304, stream: null, blob: { ...previous.blob, size: null, contentType: null, etag } };
}

afterEach(() => {
  for (const service of executors.splice(0)) service.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SQL HTTP client", () => {
  it("propagates overload and infrastructure failures without query retries", async () => {
    vi.stubEnv("SQL_EXECUTOR_URL", "https://sql.internal.example");
    vi.stubEnv("SQL_EXECUTOR_TOKEN", token);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Busy" }, { status: 429, headers: { "Retry-After": "3" } })));
    await expect(runSql(collection, "SELECT 1")).rejects.toMatchObject({ name: "RateLimitError", retryAfterSeconds: 3 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 503 })));
    await expect(runSql(collection, "SELECT 1")).rejects.toMatchObject({ name: "ToolUnavailableError" });
  });
  it("fails closed without the isolated service, before fetching", async () => {
    vi.stubEnv("SQL_EXECUTOR_URL", "");
    vi.stubEnv("SQL_EXECUTOR_TOKEN", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runSql(collection, "SELECT 1")).rejects.toThrow("SQL_EXECUTOR");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects foreign Blob paths and non-reading statements before fetching", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(runSql({ ...collection, sqlBlobPath: "files/user_2/collection_1/_db/sammlung.sqlite" }, "SELECT 1")).rejects.toThrow("Datenbankpfad");
    await expect(runSql(collection, "DROP TABLE records")).rejects.toThrow("lesende");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authenticates, propagates cancellation, and keeps the result contract", async () => {
    vi.stubEnv("SQL_EXECUTOR_URL", "https://sql.internal.example");
    vi.stubEnv("SQL_EXECUTOR_TOKEN", token);
    const result = { columns: ["n"], rows: [[1]], rowCount: 1, truncated: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await expect(runSql(collection, "SELECT 1 AS n", { signal: controller.signal })).resolves.toEqual(result);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://sql.internal.example/query");
    expect(options).toMatchObject({
      method: "POST", redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({ collection, query: "SELECT 1 AS n" }),
    });
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
  });

  it("rejects plaintext nonlocal hosts and malformed results", async () => {
    vi.stubEnv("SQL_EXECUTOR_URL", "http://sql.example");
    vi.stubEnv("SQL_EXECUTOR_TOKEN", token);
    await expect(runSql(collection, "SELECT 1")).rejects.toThrow("HTTPS");
    vi.stubEnv("SQL_EXECUTOR_URL", "https://sql.example");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ columns: ["n"], rows: [[1]], rowCount: 99, truncated: false })));
    await expect(runSql(collection, "SELECT 1")).rejects.toThrow("ungueltiges Ergebnis");
  });
});

describe("isolated SQL workers", () => {
  it("executes real SQLite, caps rows, and rejects mutations", async () => {
    const service = executor({ blobGet: vi.fn<typeof get>().mockImplementation(async () => blob()) });
    const result = await service.run(collection, "SELECT n FROM records ORDER BY n");
    expect(result.rowCount).toBe(200);
    expect(result.rows[199]).toEqual([199]);
    expect(result.truncated).toBe(true);
    await expect(service.run(collection, "DELETE FROM records")).rejects.toMatchObject({ status: 400 });
  });

  it("hard-terminates a CPU-bound query and releases its slot", async () => {
    const service = executor({ concurrency: 1, queryTimeoutMs: 400 });
    await expect(service.run(collection, endless)).rejects.toMatchObject({ status: 504 });
    expect(service.stats().active).toBe(0);
    await expect(service.run(collection, "SELECT 42 AS n")).resolves.toMatchObject({ rows: [[42]] });
  });

  it("enforces the SQLite allocation limit before returning a giant value", async () => {
    const service = executor();
    await expect(service.run(collection, "SELECT randomblob(200000000)")).rejects.toMatchObject({ status: 422 });
    expect(service.stats().active).toBe(0);
    await expect(service.run(collection, "SELECT 1")).resolves.toMatchObject({ rows: [[1]] });
  });

  it("cancels running workers instead of waiting for their query timeout", async () => {
    const service = executor({ concurrency: 1, queryTimeoutMs: 10_000 });
    const controller = new AbortController();
    const query = service.run(collection, endless, { signal: controller.signal });
    const rejected = expect(query).rejects.toThrow("test cancellation");
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error("test cancellation"));
    await rejected;
    expect(service.stats().active).toBe(0);
  });

  it("bounds queue length and removes cancelled queued jobs", async () => {
    const service = executor({ concurrency: 1, maxQueue: 1, queryTimeoutMs: 500 });
    const busy = expect(service.run(collection, endless)).rejects.toMatchObject({ status: 504 });
    const controller = new AbortController();
    const queued = expect(service.run(collection, "SELECT 2", { signal: controller.signal })).rejects.toThrow("cancel queued");
    await expect(service.run(collection, "SELECT 3")).rejects.toMatchObject({ status: 429 });
    expect(service.stats().queued).toBe(1);
    controller.abort(new Error("cancel queued"));
    await queued;
    expect(service.stats().queued).toBe(0);
    await busy;
  });

  it("expires queued work before it acquires a worker", async () => {
    const service = executor({ concurrency: 1, maxQueue: 1, queryTimeoutMs: 400, queueTimeoutMs: 30 });
    const busy = expect(service.run(collection, endless)).rejects.toMatchObject({ status: 504 });
    await expect(service.run(collection, "SELECT 2")).rejects.toMatchObject({ status: 429 });
    expect(service.stats().queued).toBe(0);
    await busy;
  });
});

describe("versioned bounded Blob cache", () => {
  it("revalidates ETags at origin, sees replacements and does not serve deleted data", async () => {
    const source = vi.fn<typeof get>()
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(unchanged())
      .mockResolvedValueOnce(blob(bytes, '"v2"'))
      .mockResolvedValueOnce(null);
    const service = executor({ blobGet: source });
    const query = "SELECT COUNT(*) FROM records";
    await service.run(collection, query);
    await expect(service.run(collection, query)).resolves.toMatchObject({ rows: [[250]] });
    expect(source.mock.calls[1][1]).toMatchObject({ access: "private", useCache: false, ifNoneMatch: '"v1"' });
    await service.run(collection, query);
    await expect(service.run(collection, query)).rejects.toMatchObject({ status: 422 });
    expect(source.mock.calls[3][1]).toMatchObject({ ifNoneMatch: '"v2"' });
    expect(service.stats().cachedBytes).toBe(0);
  });

  it("does not use stale cached bytes when revalidation fails", async () => {
    const source = vi.fn<typeof get>().mockResolvedValueOnce(blob()).mockRejectedValueOnce(new Error("origin unavailable"));
    const service = executor({ blobGet: source });
    await service.run(collection, "SELECT 1");
    await expect(service.run(collection, "SELECT 1")).rejects.toThrow("origin unavailable");
  });

  it("bounds cached bytes and separates tenants", async () => {
    const source = vi.fn<typeof get>().mockImplementation(async () => blob());
    const service = executor({ blobGet: source, cacheBytes: bytes.byteLength });
    const other = { userId: "user_2", id: collection.id, sqlBlobPath: "files/user_2/" + collection.id + "/_db/sammlung.sqlite" };
    await service.run(collection, "SELECT 1");
    await service.run(other, "SELECT 1");
    expect(source.mock.calls[1][1].ifNoneMatch).toBeUndefined();
    expect(service.stats().cachedBytes).toBe(bytes.byteLength);
    await service.run(collection, "SELECT 1");
    expect(source.mock.calls[2][1].ifNoneMatch).toBeUndefined();
  });

  it("enforces the streamed byte limit even if metadata understates size", async () => {
    const advertised = blob();
    const source = vi.fn<typeof get>().mockResolvedValue({ ...advertised, blob: { ...advertised.blob, size: 1, contentType: "application/vnd.sqlite3" } } as GetBlobResult);
    const service = executor({ blobGet: source, maxBlobBytes: 100 });
    await expect(service.run(collection, "SELECT 1")).rejects.toMatchObject({ status: 413 });
    expect(service.stats().cachedBytes).toBe(0);
    expect(service.stats().active).toBe(0);
  });
});

describe("HTTP service boundary", () => {
  it("requires authentication and supports the main-app client end to end", async () => {
    const service = executor();
    const server = createSqlServer({ token, executor: service });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    try {
      const unauthenticated = await fetch(base + "/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(unauthenticated.status).toBe(401);
      vi.stubEnv("SQL_EXECUTOR_URL", base);
      vi.stubEnv("SQL_EXECUTOR_TOKEN", token);
      await expect(runSql(collection, "SELECT 7 AS answer")).resolves.toEqual({ columns: ["answer"], rows: [[7]], rowCount: 1, truncated: false });
      const controller = new AbortController();
      const query = runSql(collection, endless, { signal: controller.signal });
      const rejected = expect(query).rejects.toThrow();
      await vi.waitFor(() => expect(service.stats().active).toBe(1));
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(service.stats().active).toBe(0));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
