import { parentPort, workerData } from "node:worker_threads";
import initSqlJs from "sql.js";
import { assertReadOnlySql, SQL_MAX_BYTES, SQL_MAX_ROWS, SQL_MAX_RESULT_BYTES } from "./sql-policy.mjs";

// One database and one query per worker. The parent terminates the entire
// worker on timeout/cancellation, even when SQLite is in synchronous WASM.
let db;
try {
  const { bytes, query, sqliteMemoryBytes } = workerData;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > SQL_MAX_BYTES) throw new Error("Die Datenbank ist zu gross.");
  const safe = assertReadOnlySql(query);
  const SQL = await initSqlJs();
  db = bytes.byteLength ? new SQL.Database(bytes) : new SQL.Database();
  db.exec(`PRAGMA hard_heap_limit=${sqliteMemoryBytes}`);
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096");
  const statement = db.prepare(`SELECT * FROM (${safe}\n) AS abfrage LIMIT ${SQL_MAX_ROWS + 1}`);
  try {
    const columns = statement.getColumnNames();
    if (columns.length > 100 || columns.some((name) => name.length > 200)) throw new Error("Bitte hoechstens 100 Spalten mit kurzen Namen auswaehlen.");
    const rows = [];
    let truncated = false;
    // Leave room for JSON punctuation, column names and the response envelope.
    let resultBytes = Buffer.byteLength(JSON.stringify(columns)) + 128;
    while (statement.step()) {
      if (rows.length === SQL_MAX_ROWS) { truncated = true; break; }
      const row = statement.get().map((value) => {
        if (value === null || typeof value === "number") return value;
        if (value instanceof Uint8Array) return `<blob ${value.byteLength} B>`;
        const text = String(value);
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      });
      resultBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (resultBytes > SQL_MAX_RESULT_BYTES) { truncated = true; break; }
      rows.push(row);
    }
    parentPort.postMessage({ ok: true, result: { columns, rows, rowCount: rows.length, truncated } });
  } finally {
    statement.free();
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: `SQL-Fehler: ${error instanceof Error ? error.message : "Abfrage fehlgeschlagen."}`.slice(0, 1_000) });
} finally {
  db?.close();
}
