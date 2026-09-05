import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SqlExecutor, SqlServiceError } from "./executor.mjs";

const BODY_MAX_BYTES = 24 * 1024;
const digest = (value) => createHash("sha256").update(value).digest();

export function createSqlServer({ token, executor = new SqlExecutor() }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("SQL_EXECUTOR_TOKEN muss mindestens 32 Zeichen haben.");
  const expected = digest(`Bearer ${token}`);
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "2" } : {}),
      });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/healthz") return reply(200, { ok: true });
    if (request.method !== "POST" || request.url !== "/query") return reply(404, { error: "Nicht gefunden." });
    if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ""))) {
      request.resume();
      return reply(401, { error: "Nicht autorisiert." });
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      request.resume();
      return reply(415, { error: "JSON erforderlich." });
    }
    if (Number(request.headers["content-length"]) > BODY_MAX_BYTES) {
      request.resume();
      return reply(413, { error: "Die Anfrage ist zu gross." });
    }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error("Anfrage abgebrochen.")); };
    response.once("close", disconnect);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_MAX_BYTES) { reply(413, { error: "Die Anfrage ist zu gross." }); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(400, { error: "Ungueltiges JSON." }); }
      const result = await executor.run(payload?.collection, payload?.query, { signal: controller.signal });
      reply(200, result);
    } catch (error) {
      reply(error instanceof SqlServiceError ? error.status : 503, {
        error: error instanceof SqlServiceError ? error.message : "Der SQL-Dienst ist voruebergehend nicht verfuegbar.",
      });
    } finally { response.removeListener("close", disconnect); }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = executor.concurrency + executor.maxQueue + 16;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN fehlt.");
  const number = (name, fallback) => process.env[name] === undefined ? fallback : Number(process.env[name]);
  const executor = new SqlExecutor({
    concurrency: number("SQL_WORKER_CONCURRENCY", 2), maxQueue: number("SQL_WORKER_QUEUE", 16),
    queueTimeoutMs: number("SQL_WORKER_QUEUE_TIMEOUT_MS", 5_000),
    queryTimeoutMs: number("SQL_WORKER_TIMEOUT_MS", 8_000),
    cacheBytes: number("SQL_WORKER_CACHE_MIB", 128) * 1024 * 1024,
  });
  const server = createSqlServer({ token: process.env.SQL_EXECUTOR_TOKEN, executor });
  server.listen(number("PORT", 8080), "0.0.0.0", () => console.log("SQL-Dienst bereit."));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => { executor.close(); server.close(() => process.exit(0)); });
  }
}
