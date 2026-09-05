import { Worker } from "node:worker_threads";
import { get } from "@vercel/blob";
import { assertCollection, assertReadOnlySql, SQL_MAX_BYTES } from "./sql-policy.mjs";

export class SqlServiceError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

/** Per-replica admission: queued jobs contain only a small query, never Blob data. */
export class SqlExecutor {
  constructor({
    concurrency = 2, maxQueue = 16, queueTimeoutMs = 5_000,
    queryTimeoutMs = 8_000, blobTimeoutMs = 10_000,
    cacheBytes = 128 * 1024 * 1024, maxBlobBytes = SQL_MAX_BYTES,
    sqliteMemoryBytes = 128 * 1024 * 1024,
    blobGet = get, workerUrl = new URL("./worker.mjs", import.meta.url),
  } = {}) {
    for (const [name, value, min, max] of [
      ["concurrency", concurrency, 1, 32], ["maxQueue", maxQueue, 0, 1_000],
      ["queueTimeoutMs", queueTimeoutMs, 1, 30_000], ["queryTimeoutMs", queryTimeoutMs, 1, 30_000],
      ["blobTimeoutMs", blobTimeoutMs, 1, 30_000], ["cacheBytes", cacheBytes, 0, 1024 ** 3],
      ["maxBlobBytes", maxBlobBytes, 1, SQL_MAX_BYTES], ["sqliteMemoryBytes", sqliteMemoryBytes, SQL_MAX_BYTES, 512 * 1024 * 1024],
    ]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Ungueltiges SQL-Limit: ${name}`);
    }
    Object.assign(this, { concurrency, maxQueue, queueTimeoutMs, queryTimeoutMs, blobTimeoutMs, cacheBytes, maxBlobBytes, sqliteMemoryBytes, blobGet, workerUrl });
    this.active = 0;
    this.queue = [];
    this.cache = new Map();
    this.cachedBytes = 0;
    this.closed = false;
  }

  stats() { return { active: this.active, queued: this.queue.length, cachedBytes: this.cachedBytes }; }

  async run(collection, query, { signal } = {}) {
    let scoped, safe;
    try { scoped = assertCollection(collection); safe = assertReadOnlySql(query); }
    catch (error) { throw new SqlServiceError(error.message, 400); }
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      const bytes = await this.load(scoped.sqlBlobPath, signal);
      signal?.throwIfAborted();
      return await this.execute(bytes, safe, signal);
    } finally { release(); }
  }

  acquire(signal) {
    if (this.closed) return Promise.reject(new SqlServiceError("Der SQL-Dienst wird beendet."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new SqlServiceError("Der SQL-Dienst ist ausgelastet. Bitte spaeter erneut versuchen.", 429));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, cleanup: () => {} };
      const cancel = (error) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.cleanup();
        reject(error);
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new SqlServiceError("Die SQL-Warteschlange ist ausgelastet.", 429)), this.queueTimeoutMs);
      entry.cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
    });
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      next.cleanup();
      this.active++;
      next.resolve(() => this.release());
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) { entry.cleanup(); entry.reject(new SqlServiceError("Der SQL-Dienst wird beendet.")); }
    this.cache.clear();
    this.cachedBytes = 0;
  }

  evict(path) {
    const prior = this.cache.get(path);
    if (prior) this.cachedBytes -= prior.bytes.byteLength;
    this.cache.delete(path);
  }

  async load(path, outerSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(this.blobTimeoutMs), ...(outerSignal ? [outerSignal] : [])]);
    const cached = this.cache.get(path);
    // A pathname is mutable. Revalidate against origin EVERY time; only a 304
    // for the exact cached ETag allows reuse. No stale-cache fallback on error.
    const result = await this.blobGet(path, {
      access: "private", useCache: false, abortSignal: signal,
      ...(cached?.etag ? { ifNoneMatch: cached.etag } : {}),
    });
    if (!result) { this.evict(path); return new Uint8Array(); }
    if (result.statusCode === 304) {
      if (!cached || result.blob.etag !== cached.etag) throw new SqlServiceError("Ungueltige Datenbankversion vom Dateispeicher.");
      // Refresh LRU order only if this version is still the stored entry.
      if (this.cache.get(path) === cached) { this.cache.delete(path); this.cache.set(path, cached); }
      return cached.bytes;
    }
    if (result.blob.size > this.maxBlobBytes) {
      await result.stream.cancel();
      throw new SqlServiceError("Die Datenbank dieser Sammlung ist zu gross.", 413);
    }
    const chunks = [];
    let size = 0;
    const reader = result.stream.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBlobBytes) { await reader.cancel(); throw new SqlServiceError("Die Datenbank dieser Sammlung ist zu gross.", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.evict(path);
    if (result.blob.etag && size <= this.cacheBytes && !this.closed) {
      while (this.cachedBytes + size > this.cacheBytes && this.cache.size) this.evict(this.cache.keys().next().value);
      this.cache.set(path, { etag: result.blob.etag, bytes });
      this.cachedBytes += size;
    }
    return bytes;
  }

  execute(bytes, query, signal) {
    return new Promise((resolve, reject) => {
      const copy = bytes.slice();
      const worker = new Worker(this.workerUrl, {
        workerData: { bytes: copy, query, sqliteMemoryBytes: this.sqliteMemoryBytes },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let finished = false;
      const finish = async (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        // Do not admit another job until termination actually releases memory.
        await worker.terminate();
        if (error) reject(error); else resolve(result);
      };
      const abort = () => { void finish(signal.reason); };
      const timer = setTimeout(() => { void finish(new SqlServiceError("Die SQL-Abfrage hat das Zeitlimit erreicht.", 504)); }, this.queryTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (message) => { void finish(message.ok ? null : new SqlServiceError(message.error, 422), message.result); });
      worker.once("error", () => { void finish(new SqlServiceError("Die SQL-Abfrage hat das Ressourcenlimit erreicht.", 422)); });
      worker.once("exit", () => { if (!finished) void finish(new SqlServiceError("Die SQL-Abfrage wurde vorzeitig beendet.", 422)); });
    });
  }
}
