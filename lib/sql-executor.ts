import { z } from "zod";
import { assertCollection, assertReadOnlySql, SQL_MAX_RESULT_BYTES } from "../services/sql/sql-policy.mjs";
import { requireEnv } from "./env";
import { RateLimitError, ToolUnavailableError, ValidationError } from "./errors";
import type { QueryResult } from "./sqlstore";

export type SqlCollection = { userId: string; id: string; sqlBlobPath: string };

const resultSchema = z.object({
  columns: z.array(z.string().max(200)).max(100),
  rows: z.array(z.array(z.union([z.string().max(201), z.number(), z.null()])).max(100)).max(200),
  rowCount: z.number().int().min(0).max(200),
  truncated: z.boolean(),
});

/** Never runs WASM inside a Next.js request; missing isolation fails closed. */
export async function runSql(
  collection: SqlCollection,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<QueryResult> {
  let scoped: SqlCollection;
  let safe: string;
  try {
    scoped = assertCollection(collection);
    safe = assertReadOnlySql(query);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Ungueltige SQL-Abfrage.");
  }
  const env = requireEnv("SQL_EXECUTOR_URL", "SQL_EXECUTOR_TOKEN");
  const base = new URL(env.SQL_EXECUTOR_URL);
  if (
    base.username || base.password || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  ) {
    throw new Error("SQL_EXECUTOR_URL muss HTTPS verwenden (lokal ist HTTP erlaubt).");
  }
  const endpoint = new URL(`${base.href.replace(/\/$/, "")}/query`);
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SQL_EXECUTOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ collection: scoped, query: safe }),
    cache: "no-store",
    redirect: "error",
    signal,
  }).catch((error) => {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new ToolUnavailableError(error instanceof Error ? `SQL-Dienst nicht erreichbar: ${error.message}` : undefined);
  });
  if (response.status === 429) {
    await response.body?.cancel();
    const retry = Number(response.headers.get("Retry-After"));
    throw new RateLimitError(Number.isFinite(retry) && retry > 0 ? Math.min(300, Math.ceil(retry)) : 2);
  }
  if (response.status >= 500 || response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ToolUnavailableError();
  }
  if (!response.body) throw new ToolUnavailableError("Der SQL-Dienst hat keine Antwort geliefert.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SQL_MAX_RESULT_BYTES) {
        await reader.cancel();
        throw new ToolUnavailableError("Die Antwort des SQL-Dienstes ist zu gross.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw error instanceof ToolUnavailableError ? error : new ToolUnavailableError();
  } finally {
    reader.releaseLock();
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ToolUnavailableError("Der SQL-Dienst hat ein ungueltiges Ergebnis geliefert."); }
  if (!response.ok) {
    const message = z.object({ error: z.string().max(1_000) }).safeParse(payload);
    throw new ValidationError(message.success ? message.data.error : "Die SQL-Abfrage konnte nicht ausgefuehrt werden.");
  }
  const parsed = resultSchema.safeParse(payload);
  if (!parsed.success) throw new ToolUnavailableError("Der SQL-Dienst hat ein ungueltiges Ergebnis geliefert.");
  const result = parsed.data;
  if (result.rowCount !== result.rows.length || result.rows.some((row) => row.length !== result.columns.length)) {
    throw new ToolUnavailableError("Der SQL-Dienst hat ein ungueltiges Ergebnis geliefert.");
  }
  return result;
}
