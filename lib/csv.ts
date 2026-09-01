import Papa from "papaparse";
import type { SqlColumn } from "./collection-kinds";
import { ValidationError } from "./errors";

/**
 * CSV -> Tabellenbeschreibung fuer SQLite.
 *
 * Deutsche Exporte kommen oft mit `;` als Trenner und Dezimalkomma; beides
 * wird erkannt. Die Kopfzeile ist Pflicht, Spaltennamen werden zu sicheren
 * SQL-Bezeichnern, und je Spalte wird der engste passende Typ bestimmt.
 */

export const CSV_MAX_BYTES = 20 * 1024 * 1024;
export const CSV_MAX_ROWS = 200_000;
export const CSV_MAX_COLUMNS = 200;

export type ParsedCsv = {
  columns: SqlColumn[];
  /** Zeilen in Spaltenreihenfolge, bereits typkonvertiert; leere Zellen sind `null`. */
  rows: (string | number | null)[][];
};

const INTEGER = /^[+-]?\d{1,18}$/;
/** 1234.56 oder 1,234.56 (Punkt als Dezimaltrenner) */
const REAL_POINT = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** 1234,56 oder 1.234,56 (Komma als Dezimaltrenner) */
const REAL_COMMA = /^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;

export function parseCsv(buffer: ArrayBuffer): ParsedCsv {
  if (buffer.byteLength > CSV_MAX_BYTES) {
    throw new ValidationError(`Die CSV-Datei ist groesser als ${CSV_MAX_BYTES / 1024 / 1024} MB.`);
  }

  // BOM entfernen — Excel schreibt ihn, papaparse wuerde ihn in den ersten Spaltennamen ziehen.
  const text = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");

  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: "greedy",
    // Ohne Angabe raet papaparse zwischen , ; \t |
    delimitersToGuess: [",", ";", "\t", "|"],
  });

  const fatal = result.errors.find((error) => error.type === "Delimiter" || error.code === "UndetectableDelimiter");
  if (fatal || result.data.length === 0) {
    throw new ValidationError("Die CSV-Datei konnte nicht gelesen werden (kein Trennzeichen erkennbar oder leer).");
  }

  const [header, ...body] = result.data;
  if (!header || header.length === 0) throw new ValidationError("Die CSV-Datei hat keine Kopfzeile.");
  if (header.length > CSV_MAX_COLUMNS) throw new ValidationError(`Mehr als ${CSV_MAX_COLUMNS} Spalten werden nicht unterstuetzt.`);
  if (body.length === 0) throw new ValidationError("Die CSV-Datei enthaelt nur eine Kopfzeile und keine Daten.");
  if (body.length > CSV_MAX_ROWS) {
    throw new ValidationError(`Die CSV-Datei hat mehr als ${CSV_MAX_ROWS.toLocaleString("de-DE")} Zeilen.`);
  }

  const names = uniqueIdentifiers(header.map(toIdentifier));
  const raw = body.map((row) => header.map((_, i) => normalizeCell(row[i])));

  const columns: SqlColumn[] = names.map((name, i) => ({ name, type: inferType(raw.map((row) => row[i])) }));
  const rows = raw.map((row) => row.map((cell, i) => convert(cell, columns[i].type)));

  return { columns, rows };
}

function normalizeCell(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Engster Typ, der auf alle nicht-leeren Werte passt. */
export function inferType(values: (string | null)[]): SqlColumn["type"] {
  let integer = true;
  let real = true;
  let anyValue = false;

  for (const value of values) {
    if (value === null) continue;
    anyValue = true;
    if (integer && !INTEGER.test(value)) integer = false;
    if (real && !(REAL_POINT.test(value) || REAL_COMMA.test(value))) real = false;
    if (!integer && !real) return "TEXT";
  }

  if (!anyValue) return "TEXT";
  return integer ? "INTEGER" : real ? "REAL" : "TEXT";
}

/** Zahl aus deutscher oder englischer Schreibweise; alles andere bleibt Text. */
export function toNumber(value: string): number | null {
  if (INTEGER.test(value)) return Number(value);
  if (REAL_COMMA.test(value) && value.includes(",")) return Number(value.replace(/\./g, "").replace(",", "."));
  if (REAL_POINT.test(value)) return Number(value.replace(/,/g, ""));
  return null;
}

function convert(cell: string | null, type: SqlColumn["type"]): string | number | null {
  if (cell === null) return null;
  if (type === "TEXT") return cell;
  const number = toNumber(cell);
  return number === null ? cell : number;
}

/** Spaltenname -> sicherer Bezeichner: klein, [a-z0-9_], beginnt nicht mit Ziffer. */
export function toIdentifier(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  const safe = cleaned.length === 0 ? "spalte" : /^\d/.test(cleaned) ? `c_${cleaned}` : cleaned;
  return RESERVED.has(safe) ? `${safe}_` : safe;
}

function uniqueIdentifiers(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

/** Tabellenname aus dem Dateinamen: "Umsatz 2025.csv" -> "umsatz_2025". */
export function tableNameFromFilename(filename: string): string {
  return toIdentifier(filename.replace(/\.[^.]+$/, ""));
}

const RESERVED = new Set([
  "select", "from", "where", "table", "index", "order", "group", "by", "limit", "join", "on", "as",
  "and", "or", "not", "null", "in", "is", "like", "between", "case", "when", "then", "else", "end",
  "create", "drop", "insert", "update", "delete", "values", "into", "set", "primary", "key", "default",
  "union", "all", "distinct", "having", "exists", "with", "cast", "column", "rowid",
]);
