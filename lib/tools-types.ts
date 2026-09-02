/**
 * Typen der Werkzeugaufrufe im Chat — ohne Laufzeitcode, damit Datenmodell und
 * Client-Komponenten sie importieren koennen, ohne die Werkzeuge selbst
 * (und deren Server-Abhaengigkeiten) mitzuziehen.
 *
 * Die Werkzeuge selbst liegen in lib/tools.ts (SQL, Cypher) und lib/ai.ts
 * (Dokumentsuche); die Namen hier muessen zu den Schluesseln passen, unter
 * denen die Chat-Route sie dem Modell anbietet.
 */

export type ToolName = "dokumente_durchsuchen" | "sql_ausfuehren" | "cypher_ausfuehren";

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
  /** Erste Zeilen als Vorschau (SQL: Arrays, Cypher: Objekte). Die Suche hat keine. */
  preview?: unknown[];
  error?: string;
};
