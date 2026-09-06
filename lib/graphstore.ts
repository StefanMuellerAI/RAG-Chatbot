import type { FalkorDB } from "falkordb";
import { checkIngestionCapacity } from "./capacity";
import type { CollectionSchema } from "./collection-kinds";
import { MissingConfigError, optionalEnv } from "./env";
import { ValidationError } from "./errors";
import type { GraphDaten, GraphKante, GraphKnoten } from "./graph-extraktion";
import { BEZIEHUNG_MUSTER, LABEL_MUSTER, PROVENIENZ } from "./graph-ontologie";

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

/**
 * Ein Client pro Prozess; bei Verbindungsfehlern wird beim naechsten Aufruf
 * neu verbunden. Das Paket wird erst hier geladen: Die Chat-Function
 * importiert dieses Modul fuer das Cypher-Werkzeug, die meisten Fragen
 * brauchen es aber nie — beim Kaltstart soll es nicht mitgeladen werden.
 */
async function getClient(): Promise<FalkorDB> {
  const url = optionalEnv("FALKORDB_URL");
  if (!url) throw new MissingConfigError(["FALKORDB_URL"]);

  clientPromise ??= import("falkordb").then(({ FalkorDB }) => FalkorDB.connect({ url })).catch((error: unknown) => {
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
  checkIngestionCapacity();
  const graph = await graphOf(collectionId);
  for (const [index, statement] of statements.entries()) {
    checkIngestionCapacity();
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

/** Zeilen je UNWIND; mehr verlaengert nur die Einzelabfrage, ohne schneller zu sein. */
const IMPORT_ZEILEN_JE_ABFRAGE = 300;

/**
 * Was der Client als Parameter annimmt — hier nachgebildet statt aus
 * `falkordb/dist/...` importiert: Ein Pfad in das Paket hinein liesse den
 * Testlaeufer das Paket eifrig aufloesen, und das Modul soll ohne FalkorDB
 * importierbar bleiben.
 */
type QueryParam = null | string | number | boolean | QueryParam[] | { [key: string]: QueryParam };

/**
 * Spielt ein Extraktionsergebnis parametrisiert ein.
 *
 * Kein Statement stammt aus einer Modellantwort: Labels und Beziehungstypen
 * werden gegen ein striktes Bezeichnermuster geprueft, bevor sie in den
 * Cypher-Text gelangen; alle Werte gehen als Parameter. MERGE auf dem
 * Schluessel je Label fuehrt dieselbe Entitaet aus mehreren Dokumenten zu
 * einem Knoten zusammen. Jede Datei bekommt einen Quelle-Knoten, jeder
 * Abschnitt einen Abschnitt-Knoten; Entitaeten haengen per ERWAEHNT_IN
 * daran — so kann eine Antwort spaeter Datei und Fundstelle nennen.
 *
 * Wiederholbar: Ein zweiter Durchlauf trifft ueberall auf MERGE.
 */
export async function importGraphDaten(collectionId: string, daten: GraphDaten): Promise<void> {
  checkIngestionCapacity();
  const graph = await graphOf(collectionId);
  const fuehreAus = async (cypher: string, params: Record<string, QueryParam>, was: string) => {
    checkIngestionCapacity();
    try {
      await graph.query(cypher, { params, TIMEOUT: WRITE_TIMEOUT_MS });
    } catch (error) {
      throw new ValidationError(
        `Import (${was}) fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const { quelle, abschnitt, erwaehntIn, teilVon } = PROVENIENZ;

  await fuehreAus(
    `MERGE (q:${quelle} {docId: $docId}) SET q.name = $filename`,
    { docId: daten.docId, filename: daten.filename },
    "Quelle",
  );

  await sichereIndex(graph, abschnitt, "id");
  for (const zeilen of stapel(daten.abschnitte)) {
    await fuehreAus(
      `UNWIND $zeilen AS a ` +
        `MERGE (s:${abschnitt} {id: a.id}) ` +
        `SET s.docId = $docId, s.nummer = a.nummer, s.fundstelle = a.fundstelle, s.auszug = a.auszug ` +
        `WITH s MATCH (q:${quelle} {docId: $docId}) MERGE (s)-[:${teilVon}]->(q)`,
      {
        docId: daten.docId,
        zeilen: zeilen.map((a) => ({
          id: abschnittId(daten.docId, a.nummer), nummer: a.nummer, fundstelle: a.fundstelle ?? null, auszug: a.auszug,
        })),
      },
      "Abschnitte",
    );
  }

  for (const [label, knoten] of gruppiere(daten.knoten, (k) => k.label)) {
    pruefeBezeichner(label, LABEL_MUSTER, "Label");
    await sichereIndex(graph, label, "schluessel");
    for (const zeilen of stapel(knoten)) {
      await fuehreAus(
        `UNWIND $zeilen AS k ` +
          `MERGE (n:${label} {schluessel: k.schluessel}) ` +
          `ON CREATE SET n.name = k.name ` +
          `SET n.beschreibung = coalesce(k.beschreibung, n.beschreibung)`,
        { zeilen: zeilen.map((k) => ({ schluessel: k.schluessel, name: k.name, beschreibung: k.beschreibung ?? null })) },
        `Knoten ${label}`,
      );
    }
    const erwaehnungen = knoten.flatMap((k) =>
      k.abschnitte.map((nummer) => ({ schluessel: k.schluessel, abschnitt: abschnittId(daten.docId, nummer) })),
    );
    for (const zeilen of stapel(erwaehnungen)) {
      await fuehreAus(
        `UNWIND $zeilen AS e ` +
          `MATCH (n:${label} {schluessel: e.schluessel}) MATCH (s:${abschnitt} {id: e.abschnitt}) ` +
          `MERGE (n)-[:${erwaehntIn}]->(s)`,
        { zeilen },
        `Herkunft ${label}`,
      );
    }
  }

  for (const [gruppe, kanten] of gruppiere(daten.kanten, (k) => `${k.vonLabel}|${k.typ}|${k.nachLabel}`)) {
    const [vonLabel, typ, nachLabel] = gruppe.split("|");
    pruefeBezeichner(vonLabel, LABEL_MUSTER, "Label");
    pruefeBezeichner(nachLabel, LABEL_MUSTER, "Label");
    pruefeBezeichner(typ, BEZIEHUNG_MUSTER, "Beziehungstyp");
    for (const zeilen of stapel(kanten)) {
      await fuehreAus(
        `UNWIND $zeilen AS k ` +
          `MATCH (a:${vonLabel} {schluessel: k.von}) MATCH (b:${nachLabel} {schluessel: k.nach}) ` +
          `MERGE (a)-[r:${typ}]->(b) ` +
          `ON CREATE SET r.abschnitte = k.abschnitte ` +
          `ON MATCH SET r.abschnitte = r.abschnitte + [x IN k.abschnitte WHERE NOT x IN r.abschnitte]`,
        {
          zeilen: zeilen.map((k) => ({
            von: k.von, nach: k.nach, abschnitte: k.abschnitte.map((nummer) => abschnittId(daten.docId, nummer)),
          })),
        },
        `Kanten ${typ}`,
      );
    }
  }
}

function abschnittId(docId: string, nummer: number): string {
  return `${docId}#${nummer}`;
}

function pruefeBezeichner(wert: string, muster: RegExp, was: string): void {
  if (!muster.test(wert)) throw new ValidationError(`${was} „${wert}“ ist kein zulaessiger Bezeichner.`);
}

/**
 * Ein Bereichsindex je Label auf dem Schluessel; ohne ihn liefe jedes MERGE
 * ueber alle Knoten des Labels. Ein vorhandener Index ist kein Fehler.
 */
async function sichereIndex(graph: Awaited<ReturnType<typeof graphOf>>, label: string, eigenschaft: string): Promise<void> {
  pruefeBezeichner(label, LABEL_MUSTER, "Label");
  checkIngestionCapacity();
  try {
    await graph.query(`CREATE INDEX FOR (n:${label}) ON (n.${eigenschaft})`, { TIMEOUT: WRITE_TIMEOUT_MS });
  } catch (error) {
    const meldung = error instanceof Error ? error.message : String(error);
    if (!/already indexed|already exists/i.test(meldung)) throw error;
  }
}

function gruppiere<T>(eintraege: T[], schluessel: (eintrag: T) => string): Map<string, T[]> {
  const gruppen = new Map<string, T[]>();
  for (const eintrag of eintraege) {
    const key = schluessel(eintrag);
    const gruppe = gruppen.get(key);
    if (gruppe) gruppe.push(eintrag);
    else gruppen.set(key, [eintrag]);
  }
  return gruppen;
}

function* stapel<T>(eintraege: T[]): Generator<T[]> {
  for (let i = 0; i < eintraege.length; i += IMPORT_ZEILEN_JE_ABFRAGE) {
    yield eintraege.slice(i, i + IMPORT_ZEILEN_JE_ABFRAGE);
  }
}

export type { GraphKante, GraphKnoten };

export async function deleteGraph(collectionId: string): Promise<void> {
  checkIngestionCapacity();
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
  checkIngestionCapacity();
  const graph = await graphOf(collectionId);
  checkIngestionCapacity();
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
  const { text, maske } = cypherOhneKommentare(trimmed);
  if (maske.includes(";")) {
    throw new ValidationError("Bitte genau ein Cypher-Statement ohne Semikolon.");
  }

  // Only inspect outer clauses. LIMIT in strings, identifiers, properties or
  // subqueries must not be mistaken for the result limit. UNION would apply
  // an appended LIMIT only to its last branch, so require separate queries.
  const tokens = [...maske.matchAll(/(?<![.\w])\b(RETURN|LIMIT|UNION)\b/gi)];
  if (tokens.some((token) => token[1].toUpperCase() === "UNION")) {
    throw new ValidationError("Bitte UNION in getrennten Graph-Abfragen ausfuehren.");
  }
  const letztesReturn = [...tokens].reverse().find((token) => token[1].toUpperCase() === "RETURN");
  if (!letztesReturn) throw new ValidationError("Eine Graph-Abfrage braucht RETURN.");
  const limit = [...tokens].reverse().find((token) => token[1].toUpperCase() === "LIMIT" && token.index! > letztesReturn.index!);
  if (limit) {
    const wert = /^LIMIT\s+(\d+)\s*$/i.exec(maske.slice(limit.index));
    if (!wert) throw new ValidationError("LIMIT muss eine nichtnegative ganze Zahl am Ende der Abfrage sein.");
    const begrenzt = BigInt(wert[1]) > BigInt(CYPHER_MAX_ROWS) ? CYPHER_MAX_ROWS : Number(wert[1]);
    return `${text.slice(0, limit.index).trimEnd()} LIMIT ${begrenzt}`;
  }
  return `${text.trimEnd()} LIMIT ${CYPHER_MAX_ROWS}`;
}

/** Keep offsets stable while stripping comments and masking literals/nesting. */
function cypherOhneKommentare(eingabe: string): { text: string; maske: string } {
  const text = eingabe.split("");
  const maske = eingabe.split("");
  const klammern: string[] = [];
  for (let i = 0; i < eingabe.length; i++) {
    const start = i;
    const zeichen = eingabe[i];
    if (zeichen === "'" || zeichen === '"' || zeichen === "`") {
      let geschlossen = false;
      for (i++; i < eingabe.length; i++) {
        if (eingabe[i] === "\\") { i++; continue; }
        if (eingabe[i] === zeichen) {
          if (eingabe[i + 1] === zeichen) { i++; continue; }
          geschlossen = true;
          break;
        }
      }
      if (!geschlossen) throw new ValidationError("Ein Cypher-Text oder Bezeichner ist nicht abgeschlossen.");
      for (let n = start; n <= i; n++) maske[n] = " ";
      continue;
    }
    if (eingabe.slice(i, i + 2) === "//" || eingabe.slice(i, i + 2) === "/*") {
      const block = eingabe[i + 1] === "*";
      const ende = block ? eingabe.indexOf("*/", i + 2) : eingabe.indexOf("\n", i + 2);
      if (block && ende < 0) throw new ValidationError("Ein Cypher-Kommentar ist nicht abgeschlossen.");
      i = ende < 0 ? eingabe.length - 1 : block ? ende + 1 : ende - 1;
      for (let n = start; n <= i; n++) text[n] = maske[n] = " ";
      continue;
    }
    if ("([{".includes(zeichen)) {
      klammern.push(zeichen);
      maske[i] = " ";
    } else if (")]}".includes(zeichen)) {
      const offen = klammern.pop();
      if (!offen || "([{".indexOf(offen) !== ")]}".indexOf(zeichen)) {
        throw new ValidationError("Ungueltige Klammern in der Cypher-Abfrage.");
      }
      maske[i] = " ";
    } else if (klammern.length > 0) {
      maske[i] = " ";
    }
  }
  if (klammern.length) throw new ValidationError("Ungueltige Klammern in der Cypher-Abfrage.");
  return { text: text.join(""), maske: maske.join("") };
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
