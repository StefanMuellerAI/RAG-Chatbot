import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { CollectionSchema, SqlColumn, SqlTableSchema } from "./collection-kinds";
import { requireEnv } from "./env";
import { ValidationError } from "./errors";

/**
 * Tabellen-Sammlungen: eine SQLite-Datenbank je Sammlung, als Datei in Vercel
 * Blob (`db/<collectionId>.sqlite`). Zur Laufzeit wird sie in den Speicher
 * geladen und mit sql.js (SQLite als WebAssembly) abgefragt — es gibt keinen
 * Datenbankserver, und jede Anfrage arbeitet auf einer frischen Kopie.
 */

export const SQLITE_MAX_BYTES = 50 * 1024 * 1024;
export const SQL_MAX_ROWS = 200;
const CELL_MAX_CHARS = 200;
const SAMPLE_COLUMNS = 25;

const DB_PREFIX = "db/";

export function databasePath(collectionId: string): string {
  return `${DB_PREFIX}${collectionId}.sqlite`;
}

let sqlPromise: Promise<SqlJsStatic> | undefined;

/** sql.js einmal pro Prozess laden; die WASM-Datei kommt direkt aus node_modules. */
export function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= (async () => {
    const bytes = await readFile(wasmPfad());
    // Emscripten erwartet einen echten ArrayBuffer, nicht den Node-Buffer-View.
    const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return initSqlJs({ wasmBinary });
  })();
  return sqlPromise;
}

/**
 * Pfad der WASM-Datei: ueber die Modulaufloesung von sql.js, ersatzweise
 * relativ zum Projektverzeichnis (so liegt sie nach dem File Tracing auf Vercel).
 */
function wasmPfad(): string {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm");
  } catch {
    return path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  }
}

export async function newDatabase(): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database();
}

/** Datenbank einer Sammlung laden; ohne Datei eine leere. */
export async function loadDatabase(collectionId: string): Promise<Database> {
  requireEnv("BLOB_READ_WRITE_TOKEN");
  const SQL = await getSql();

  const result = await get(databasePath(collectionId), { access: "private" });
  if (!result) return new SQL.Database();

  const buffer = await new Response(result.stream).arrayBuffer();
  if (buffer.byteLength > SQLITE_MAX_BYTES) {
    throw new ValidationError(`Die Datenbank dieser Sammlung ist groesser als ${SQLITE_MAX_BYTES / 1024 / 1024} MB.`);
  }
  return new SQL.Database(new Uint8Array(buffer));
}

export async function saveDatabase(collectionId: string, db: Database): Promise<number> {
  requireEnv("BLOB_READ_WRITE_TOKEN");
  const bytes = db.export();
  if (bytes.byteLength > SQLITE_MAX_BYTES) {
    throw new ValidationError(`Die Datenbank wuerde ${SQLITE_MAX_BYTES / 1024 / 1024} MB ueberschreiten.`);
  }
  await put(databasePath(collectionId), Buffer.from(bytes), {
    access: "private",
    contentType: "application/vnd.sqlite3",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return bytes.byteLength;
}

export async function deleteDatabase(collectionId: string): Promise<void> {
  requireEnv("BLOB_READ_WRITE_TOKEN");
  await del(databasePath(collectionId));
}

/** Alle Datenbankdateien — fuer den Admin-Notausgang. */
export async function deleteAllDatabases(): Promise<number> {
  requireEnv("BLOB_READ_WRITE_TOKEN");
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: DB_PREFIX, cursor, limit: 250 });
    if (page.blobs.length > 0) {
      await del(page.blobs.map((blob) => blob.url));
      removed += page.blobs.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

// ---------------------------------------------------------------------------
// Tabellen schreiben
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new ValidationError(`Ungueltiger Bezeichner: ${identifier}`);
  return `"${identifier}"`;
}

/** Ersetzt (oder legt an) eine Tabelle mit den gegebenen Spalten und Zeilen. */
export function replaceTable(
  db: Database,
  table: string,
  columns: SqlColumn[],
  rows: (string | number | null)[][],
): void {
  const columnSql = columns.map((column) => `${quote(column.name)} ${column.type}`).join(", ");

  db.exec("BEGIN");
  try {
    db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
    db.exec(`CREATE TABLE ${quote(table)} (${columnSql})`);

    const placeholders = columns.map(() => "?").join(", ");
    const statement = db.prepare(`INSERT INTO ${quote(table)} VALUES (${placeholders})`);
    try {
      for (const row of rows) statement.run(row as SqlValue[]);
    } finally {
      statement.free();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function dropTable(db: Database, table: string): void {
  db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function listTables(db: Database): string[] {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return result[0]?.values.map((row) => String(row[0])) ?? [];
}

/** Tabellen, Spalten, Zeilenzahlen und Beispielwerte — fuer Prompt und Oberflaeche. */
export function describeSchema(db: Database): CollectionSchema {
  const tables: SqlTableSchema[] = listTables(db).map((table) => {
    const info = db.exec(`PRAGMA table_info(${quote(table)})`)[0]?.values ?? [];
    const columns: SqlColumn[] = info.map((row) => ({
      name: String(row[1]),
      type: normalizeType(String(row[2])),
    }));
    const rows = Number(db.exec(`SELECT COUNT(*) FROM ${quote(table)}`)[0]?.values[0]?.[0] ?? 0);

    const samples: Record<string, string[]> = {};
    for (const column of columns.slice(0, SAMPLE_COLUMNS)) {
      const werte = db.exec(
        `SELECT DISTINCT ${quote(column.name)} FROM ${quote(table)} WHERE ${quote(column.name)} IS NOT NULL LIMIT 3`,
      )[0]?.values ?? [];
      samples[column.name] = werte.map((row) => truncate(String(row[0]), 40));
    }

    return { name: table, rows, columns, samples };
  });

  return { kind: "sql", tables };
}

function normalizeType(type: string): SqlColumn["type"] {
  const upper = type.toUpperCase();
  if (upper.includes("INT")) return "INTEGER";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB") || upper.includes("NUM")) return "REAL";
  return "TEXT";
}

// ---------------------------------------------------------------------------
// Lesende Abfragen
// ---------------------------------------------------------------------------

export type QueryResult = {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  /** true, wenn mehr Zeilen existierten als zurueckgegeben wurden. */
  truncated: boolean;
};

const FORBIDDEN =
  /\b(attach|detach|pragma|insert|update|delete|drop|alter|create|vacuum|reindex|analyze)\b|\breplace\b(?!\s*\()/i;

/**
 * Laesst genau ein SELECT (auch mit WITH) durch. Der Rest ist Verteidigung in
 * der Tiefe: die Datenbank ist ohnehin nur eine Kopie im Speicher.
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.length === 0) throw new ValidationError("Die SQL-Abfrage ist leer.");
  if (trimmed.includes(";")) throw new ValidationError("Bitte genau ein SQL-Statement ohne Semikolon.");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new ValidationError("Nur lesende Abfragen (SELECT, auch mit WITH) sind erlaubt.");
  }
  if (FORBIDDEN.test(stripLiteralsAndComments(trimmed))) {
    throw new ValidationError("Die Abfrage enthaelt ein nicht erlaubtes Schluesselwort (nur lesen).");
  }
  return trimmed;
}

/** Entfernt String-Literale und Kommentare, damit Schluesselwoerter darin nicht anschlagen. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function runReadOnlyQuery(db: Database, sql: string): QueryResult {
  const safe = assertReadOnlySql(sql);
  const wrapped = `SELECT * FROM (${safe}) AS abfrage LIMIT ${SQL_MAX_ROWS + 1}`;

  let result;
  try {
    result = db.exec(wrapped)[0];
  } catch (error) {
    throw new ValidationError(`SQL-Fehler: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!result) return { columns: [], rows: [], rowCount: 0, truncated: false };

  const truncated = result.values.length > SQL_MAX_ROWS;
  const rows = result.values.slice(0, SQL_MAX_ROWS).map((row) => row.map(cell));
  return { columns: result.columns, rows, rowCount: rows.length, truncated };
}

function cell(value: SqlValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} B>`;
  return truncate(String(value), CELL_MAX_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
