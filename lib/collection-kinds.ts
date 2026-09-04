/**
 * Sammlungstypen — reine Konstanten und Typen ohne Server-Abhaengigkeiten,
 * damit Client-Komponenten sie importieren koennen.
 *
 * - vector: Dokumente (PDF/DOCX/XLSX/MP3) als Vektoren in Pinecone.
 * - sql:    CSV-Dateien als Tabellen einer SQLite-Datenbank (Blob, sql.js).
 * - graph:  Cypher-Skripte als eigener Graph in FalkorDB.
 */

export type CollectionKind = "vector" | "sql" | "graph";

export const COLLECTION_KINDS: readonly CollectionKind[] = ["vector", "sql", "graph"];

export function isCollectionKind(value: unknown): value is CollectionKind {
  return typeof value === "string" && (COLLECTION_KINDS as readonly string[]).includes(value);
}

export const KIND_LABEL: Record<CollectionKind, string> = {
  vector: "Dokumente",
  sql: "Tabellen",
  graph: "Graph",
};

export const KIND_DESCRIPTION: Record<CollectionKind, string> = {
  vector: "PDF, DOCX, XLSX, MP3 — semantische Suche in Textabschnitten (Vektor-Datenbank).",
  sql: "CSV-Dateien werden zu Tabellen einer relationalen Datenbank; die KI schreibt SQL.",
  graph: "Cypher-Skript wird zu einem Graphen (Knoten und Kanten); die KI schreibt Cypher.",
};

/** Zulaessige Dateiendungen je Typ — im Upload-Dialog und in der Verarbeitung. */
export const KIND_EXTENSIONS: Record<CollectionKind, readonly string[]> = {
  vector: [".pdf", ".docx", ".xlsx", ".mp3"],
  sql: [".csv"],
  graph: [".cypher", ".cql", ".txt"],
};

/** Wie die "Einheiten" eines Dokuments heissen (Abschnitte, Zeilen, Statements). */
export const KIND_UNIT: Record<CollectionKind, string> = {
  vector: "Abschnitte",
  sql: "Zeilen",
  graph: "Statements",
};

export type SqlColumn = { name: string; type: "INTEGER" | "REAL" | "TEXT" };

export type SqlTableSchema = {
  name: string;
  rows: number;
  columns: SqlColumn[];
  /** Ein paar Beispielwerte je Spalte — hilft dem Modell beim Formulieren von Filtern. */
  samples?: Record<string, string[]>;
};

export type CollectionSchema =
  | { kind: "sql"; tables: SqlTableSchema[] }
  | {
      kind: "graph";
      nodes: number;
      relationships: number;
      labels: string[];
      relationshipTypes: string[];
      propertyKeys: string[];
    };
