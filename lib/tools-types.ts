/**
 * Typen der Werkzeugaufrufe im Chat — ohne Laufzeitcode, damit Datenmodell und
 * Client-Komponenten sie importieren koennen, ohne die Werkzeuge selbst
 * (und deren Server-Abhaengigkeiten) mitzuziehen.
 *
 * Die Werkzeuge selbst (Suche, SQL, Cypher) kommen in einer spaeteren Phase;
 * die Spalte `messages.steps` haelt ihre Schritte schon jetzt vor.
 */

export type ToolName = "search_documents" | "run_sql" | "run_cypher";

/** Ein Werkzeugaufruf, wie er dem Browser gemeldet und an der Nachricht gespeichert wird. */
export type ToolStep = {
  tool: ToolName;
  collectionId: string;
  collectionName: string;
  /** Suchbegriff, SQL oder Cypher. */
  query: string;
  rowCount?: number;
  truncated?: boolean;
  columns?: string[];
  /** Erste Zeilen als Vorschau (SQL/Cypher) bzw. Auszuege (Suche). */
  preview?: unknown[];
  error?: string;
};
