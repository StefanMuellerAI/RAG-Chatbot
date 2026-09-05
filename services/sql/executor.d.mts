import type { get } from "@vercel/blob";
import type { SqlCollection } from "./sql-policy.mjs";
export type QueryResult = { columns: string[]; rows: (string | number | null)[][]; rowCount: number; truncated: boolean };
export class SqlServiceError extends Error { status: number; constructor(message: string, status?: number); }
export class SqlExecutor {
  constructor(options?: {
    concurrency?: number; maxQueue?: number; queueTimeoutMs?: number;
    queryTimeoutMs?: number; blobTimeoutMs?: number; cacheBytes?: number;
    maxBlobBytes?: number; sqliteMemoryBytes?: number; blobGet?: typeof get; workerUrl?: URL;
  });
  concurrency: number;
  maxQueue: number;
  run(collection: SqlCollection, query: string, options?: { signal?: AbortSignal }): Promise<QueryResult>;
  close(): void;
  stats(): { active: number; queued: number; cachedBytes: number };
}
