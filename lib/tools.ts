import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { KIND_LABEL } from "./collection-kinds";
import type { Collection } from "./collections";
import { ForbiddenError, ValidationError } from "./errors";
import { runReadOnlyCypher } from "./graphstore";
import { loadDatabase, runReadOnlyQuery } from "./sqlstore";
import { search, type Hit } from "./vector";

/**
 * Werkzeuge, mit denen das Modell Sammlungen befragt. Jeder Aufruf prueft die
 * `collectionId` gegen die Allowlist der Sitzung — das Modell kann keine
 * fremde Sammlung erreichen, egal was es erfindet.
 */

export type ToolName = "search_documents" | "run_sql" | "run_cypher";

/** Ein Werkzeugaufruf, wie er dem Browser gemeldet wird. */
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

export type ToolContext = {
  /** Sammlungen, die das Modell befragen darf. */
  collections: Collection[];
  /** Im Einzelmodus fest gebunden; dann kennt das Werkzeugschema keine collectionId. */
  fixed?: Collection;
  /** Sammelt Vektor-Treffer fuer die Fundstellen unter der Antwort. */
  onHits?: (hits: Hit[], collection: Collection) => void;
};

/** Zeichenbudget fuer ein Werkzeugergebnis im Prompt — grosse Tabellen werden gekuerzt. */
const RESULT_MAX_CHARS = 24_000;
const SEARCH_TOP_K = 8;
const MIN_SCORE = 0.35;

function resolveCollection(context: ToolContext, collectionId: string | undefined): Collection {
  if (context.fixed) return context.fixed;
  if (!collectionId) throw new ValidationError("collectionId fehlt.");
  const collection = context.collections.find((c) => c.id === collectionId);
  if (!collection) {
    throw new ForbiddenError(
      `Sammlung ${collectionId} ist nicht verfuegbar. Erlaubt sind: ${context.collections.map((c) => c.id).join(", ")}`,
    );
  }
  return collection;
}

function requireKind(collection: Collection, kind: Collection["kind"]): void {
  if (collection.kind !== kind) {
    throw new ValidationError(
      `Sammlung "${collection.name}" ist vom Typ ${KIND_LABEL[collection.kind]}, dieses Werkzeug braucht ${KIND_LABEL[kind]}.`,
    );
  }
}

/** Kuerzt Zeilen, bis das Ergebnis ins Zeichenbudget passt. */
function capRows<T>(rows: T[]): { rows: T[]; capped: boolean } {
  let ende = rows.length;
  while (ende > 0 && JSON.stringify(rows.slice(0, ende)).length > RESULT_MAX_CHARS) {
    ende = Math.floor(ende / 2);
  }
  return { rows: rows.slice(0, ende), capped: ende < rows.length };
}

function fehlertext(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildTools(context: ToolContext): ToolSet {
  const kinds = new Set((context.fixed ? [context.fixed] : context.collections).map((c) => c.kind));

  // Im Einzelmodus ist die Sammlung fest gebunden; das Feld bleibt optional
  // im Schema, damit beide Modi denselben Typ haben, und wird dann ignoriert.
  const collectionId = z
    .string()
    .optional()
    .describe(
      context.fixed
        ? "Nicht noetig — es gibt genau eine Sammlung."
        : "ID der Sammlung aus der Liste im Systemprompt (Pflicht).",
    );

  let laufendeNummer = 0;
  const tools: ToolSet = {};

  if (kinds.has("vector")) {
    tools.search_documents = tool({
      description:
        "Semantische Suche in einer Dokumentensammlung. Liefert die relevantesten Textauszuege mit Nummer, Dateiname und Fundstelle. Zitiere Auszuege mit ihrer Nummer in eckigen Klammern.",
      inputSchema: z.object({
        collectionId,
        query: z.string().min(1).max(500).describe("Suchanfrage in natuerlicher Sprache, moeglichst konkret."),
      }),
      execute: async ({ collectionId, query }) => {
        const collection = resolveCollection(context, collectionId);
        requireKind(collection, "vector");
        try {
          const hits = (await search(collection.namespace, query, SEARCH_TOP_K)).filter((hit) => hit.score >= MIN_SCORE);
          const start = laufendeNummer;
          laufendeNummer += hits.length;
          context.onHits?.(hits, collection);
          return {
            ok: true as const,
            collection: collection.name,
            excerpts: hits.map((hit, i) => ({
              n: start + i + 1,
              filename: hit.metadata.filename,
              location: hit.metadata.location ?? null,
              text: hit.text,
            })),
          };
        } catch (error) {
          return { ok: false as const, error: fehlertext(error) };
        }
      },
    });
  }

  if (kinds.has("sql")) {
    tools.run_sql = tool({
      description:
        "Fuehrt genau eine lesende SQL-Abfrage (SQLite-Dialekt, SELECT oder WITH) gegen die Tabellen einer Tabellen-Sammlung aus. Maximal 200 Zeilen; aggregiere in SQL statt viele Zeilen zu lesen.",
      inputSchema: z.object({
        collectionId,
        sql: z.string().min(1).max(4000).describe("Eine einzelne SELECT-Abfrage ohne Semikolon."),
      }),
      execute: async ({ collectionId, sql }) => {
        const collection = resolveCollection(context, collectionId);
        requireKind(collection, "sql");
        try {
          const db = await loadDatabase(collection.id);
          try {
            const result = runReadOnlyQuery(db, sql);
            const { rows, capped } = capRows(result.rows);
            return {
              ok: true as const,
              collection: collection.name,
              columns: result.columns,
              rows,
              rowCount: result.rowCount,
              truncated: result.truncated || capped,
            };
          } finally {
            db.close();
          }
        } catch (error) {
          return { ok: false as const, error: fehlertext(error) };
        }
      },
    });
  }

  if (kinds.has("graph")) {
    tools.run_cypher = tool({
      description:
        "Fuehrt genau eine lesende Cypher-Abfrage (openCypher, FalkorDB) gegen den Graphen einer Graph-Sammlung aus. Maximal 200 Zeilen. Referenziere Beziehungs-Aliase in RETURN oder WHERE, wenn du Kanten zaehlst.",
      inputSchema: z.object({
        collectionId,
        cypher: z.string().min(1).max(4000).describe("Eine einzelne MATCH/RETURN-Abfrage ohne Semikolon."),
      }),
      execute: async ({ collectionId, cypher }) => {
        const collection = resolveCollection(context, collectionId);
        requireKind(collection, "graph");
        try {
          const result = await runReadOnlyCypher(collection.id, cypher);
          const { rows, capped } = capRows(result.rows);
          return {
            ok: true as const,
            collection: collection.name,
            columns: result.columns,
            rows,
            rowCount: result.rowCount,
            truncated: result.truncated || capped,
          };
        } catch (error) {
          return { ok: false as const, error: fehlertext(error) };
        }
      },
    });
  }

  return tools;
}

/** Werkzeugaufruf + Ergebnis -> Ereignis fuer den Browser. */
export function toStep(
  context: ToolContext,
  toolName: string,
  input: unknown,
  output: unknown,
  error?: unknown,
): ToolStep | null {
  if (toolName !== "search_documents" && toolName !== "run_sql" && toolName !== "run_cypher") return null;

  const eingabe = (input ?? {}) as { collectionId?: string; query?: string; sql?: string; cypher?: string };
  const collection = context.fixed ?? context.collections.find((c) => c.id === eingabe.collectionId);
  const ergebnis = (output ?? {}) as {
    ok?: boolean;
    error?: string;
    columns?: string[];
    rows?: unknown[];
    rowCount?: number;
    truncated?: boolean;
    excerpts?: unknown[];
  };

  const step: ToolStep = {
    tool: toolName,
    collectionId: collection?.id ?? eingabe.collectionId ?? "?",
    collectionName: collection?.name ?? eingabe.collectionId ?? "unbekannt",
    query: eingabe.query ?? eingabe.sql ?? eingabe.cypher ?? "",
  };

  if (error !== undefined) step.error = fehlertext(error);
  else if (ergebnis.ok === false) step.error = ergebnis.error ?? "Unbekannter Fehler.";
  else if (toolName === "search_documents") {
    step.rowCount = ergebnis.excerpts?.length ?? 0;
    step.preview = (ergebnis.excerpts ?? []).slice(0, 8);
  } else {
    step.columns = ergebnis.columns;
    step.rowCount = ergebnis.rowCount;
    step.truncated = ergebnis.truncated;
    step.preview = (ergebnis.rows ?? []).slice(0, 20);
  }
  return step;
}
