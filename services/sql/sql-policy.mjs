/** Shared by the app, HTTP service and isolated worker. */
export const SQL_MAX_BYTES = 50 * 1024 * 1024;
export const SQL_MAX_ROWS = 200;
export const SQL_MAX_QUERY_CHARS = 4_000;
export const SQL_MAX_RESULT_BYTES = 256 * 1024;

export function assertCollection(collection) {
  if (!collection || typeof collection !== "object") throw new Error("Sammlung fehlt.");
  const { userId, id, sqlBlobPath } = collection;
  if (![userId, id].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw new Error("Ungueltige Sammlungs-ID.");
  }
  const expected = `files/${userId}/${id}/_db/sammlung.sqlite`;
  if (sqlBlobPath !== expected) throw new Error("Der Datenbankpfad gehoert nicht zur Sammlung.");
  return { userId, id, sqlBlobPath: expected };
}

export function assertReadOnlySql(sql) {
  if (typeof sql !== "string" || sql.length > SQL_MAX_QUERY_CHARS) {
    throw new Error(`SQL darf hoechstens ${SQL_MAX_QUERY_CHARS} Zeichen enthalten.`);
  }
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("Die SQL-Abfrage ist leer.");
  if (trimmed.includes(";")) throw new Error("Bitte genau ein SQL-Statement ohne Semikolon.");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Nur lesende Abfragen (SELECT, auch mit WITH) sind erlaubt.");
  const stripped = trimmed
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/\b(attach|detach|pragma|insert|update|delete|drop|alter|create|vacuum|reindex|analyze)\b|\breplace\b(?!\s*\()/i.test(stripped)) {
    throw new Error("Die Abfrage enthaelt ein nicht erlaubtes Schluesselwort (nur lesen).");
  }
  return trimmed;
}
