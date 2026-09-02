import { FalkorDB } from "falkordb";
import type { CollectionSchema } from "./collection-kinds";
import { MissingConfigError, optionalEnv } from "./env";
import { ValidationError } from "./errors";

/**
 * Graph-Sammlungen in FalkorDB: jede Sammlung ist ein eigener Graph
 * (`c_<collectionId>`), damit eine Cypher-Abfrage nie ueber Sammlungen
 * hinweg lesen kann. Lesende Abfragen laufen ueber GRAPH.RO_QUERY — der
 * Server lehnt Schreiboperationen darin ab.
 *
 * Dieses Modul baut auf Modulebene keine Verbindung auf und liest dort auch
 * keine Umgebung: Es muss ohne FALKORDB_URL importierbar bleiben (Build,
 * Tests, Instanzen ohne Graph-Anbindung).
 */

const GRAPH_PREFIX = "c_";
export const CYPHER_MAX_ROWS = 200;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const CELL_MAX_CHARS = 200;

let clientPromise: Promise<FalkorDB> | undefined;

/** Ein Client pro Prozess; bei Verbindungsfehlern wird beim naechsten Aufruf neu verbunden. */
async function getClient(): Promise<FalkorDB> {
  const url = optionalEnv("FALKORDB_URL");
  if (!url) throw new MissingConfigError(["FALKORDB_URL"]);

  clientPromise ??= FalkorDB.connect({ url }).catch((error: unknown) => {
    clientPromise = undefined;
    throw new Error(
      `Verbindung zu FalkorDB fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return clientPromise;
}

export function graphName(collectionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(collectionId)) {
    throw new ValidationError("Ungueltige Sammlungs-ID.");
  }
  return `${GRAPH_PREFIX}${collectionId}`;
}

async function graphOf(collectionId: string) {
  return (await getClient()).selectGraph(graphName(collectionId));
}

function istLeererGraph(error: unknown): boolean {
  return /empty key|unknown graph|does not exist/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

// ---------------------------------------------------------------------------
// Import und Loeschen
// ---------------------------------------------------------------------------

/** Spielt Statements nacheinander ein; der Fehler nennt die Statement-Nummer. */
export async function importStatements(collectionId: string, statements: string[]): Promise<void> {
  const graph = await graphOf(collectionId);
  for (const [index, statement] of statements.entries()) {
    try {
      await graph.query(statement, { TIMEOUT: WRITE_TIMEOUT_MS });
    } catch (error) {
      throw new ValidationError(
        `Statement ${index + 1} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}\n` +
          `${statement.slice(0, 200)}`,
      );
    }
  }
}

export async function deleteGraph(collectionId: string): Promise<void> {
  try {
    await (await graphOf(collectionId)).delete();
  } catch (error) {
    if (!istLeererGraph(error)) throw error;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function erstesFeld<T>(collectionId: string, cypher: string): Promise<T[]> {
  const graph = await graphOf(collectionId);
  try {
    const reply = await graph.roQuery<Record<string, T>>(cypher, { TIMEOUT: READ_TIMEOUT_MS });
    return (reply.data ?? []).map((row) => Object.values(row)[0]);
  } catch (error) {
    if (istLeererGraph(error)) return [];
    throw error;
  }
}

export async function describeGraph(collectionId: string): Promise<CollectionSchema> {
  const [labels, relationshipTypes, propertyKeys, nodes, relationships] = await Promise.all([
    erstesFeld<string>(collectionId, "CALL db.labels()"),
    erstesFeld<string>(collectionId, "CALL db.relationshipTypes()"),
    erstesFeld<string>(collectionId, "CALL db.propertyKeys()"),
    erstesFeld<number>(collectionId, "MATCH (n) RETURN count(n)"),
    erstesFeld<number>(collectionId, "MATCH ()-[r]->() WHERE ID(r) >= 0 RETURN count(r)"),
  ]);

  return {
    kind: "graph",
    nodes: Number(nodes[0] ?? 0),
    relationships: Number(relationships[0] ?? 0),
    labels,
    relationshipTypes,
    propertyKeys,
  };
}

// ---------------------------------------------------------------------------
// Lesende Abfragen
// ---------------------------------------------------------------------------

export type CypherResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};

export function prepareReadOnlyCypher(cypher: string): string {
  const trimmed = cypher.trim().replace(/;\s*$/, "");
  if (trimmed.length === 0) throw new ValidationError("Die Cypher-Abfrage ist leer.");
  if (trimmed.includes(";")) {
    throw new ValidationError("Bitte genau ein Cypher-Statement ohne Semikolon.");
  }
  // Ohne LIMIT koennte eine Abfrage den ganzen Graphen zurueckgeben.
  return /\bLIMIT\s+\d+\s*$/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${CYPHER_MAX_ROWS}`;
}

export async function runReadOnlyCypher(
  collectionId: string,
  cypher: string,
): Promise<CypherResult> {
  const graph = await graphOf(collectionId);
  const safe = prepareReadOnlyCypher(cypher);

  let reply;
  try {
    reply = await graph.roQuery<Record<string, unknown>>(safe, { TIMEOUT: READ_TIMEOUT_MS });
  } catch (error) {
    if (istLeererGraph(error)) return { columns: [], rows: [], rowCount: 0, truncated: false };
    throw new ValidationError(
      `Cypher-Fehler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const alle = reply.data ?? [];
  const truncated = alle.length > CYPHER_MAX_ROWS;
  const rows = alle.slice(0, CYPHER_MAX_ROWS).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, kompakt(value)])),
  );
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, rowCount: rows.length, truncated };
}

type FalkorNode = { id: number; labels: string[]; properties: Record<string, unknown> };
type FalkorEdge = { id: number; relationshipType: string; properties: Record<string, unknown> };
type FalkorPath = { nodes: FalkorNode[]; edges: FalkorEdge[] };

/** Knoten, Kanten und Pfade in eine kompakte, lesbare Form bringen. */
function kompakt(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > CELL_MAX_CHARS ? `${value.slice(0, CELL_MAX_CHARS)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(kompakt);

  const record = value as Partial<FalkorNode & FalkorEdge & FalkorPath>;
  if (Array.isArray(record.nodes) && Array.isArray(record.edges)) {
    return { type: "path", nodes: record.nodes.map(kompakt), edges: record.edges.map(kompakt) };
  }
  if (Array.isArray(record.labels)) {
    return { type: "node", labels: record.labels, properties: kompaktProperties(record.properties) };
  }
  if (typeof record.relationshipType === "string") {
    return {
      type: "edge",
      relationshipType: record.relationshipType,
      properties: kompaktProperties(record.properties),
    };
  }
  return kompaktProperties(value as Record<string, unknown>);
}

function kompaktProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties ?? {}).map(([key, value]) => [key, kompakt(value)]),
  );
}
