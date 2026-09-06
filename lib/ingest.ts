import {
  KIND_EXTENSIONS,
  KIND_LABEL,
  type CollectionKind,
  type CollectionSchema,
} from "./collection-kinds";
import { checkIngestionCapacity } from "./capacity";
import { setzeSammlungsSchema } from "./collections";
import { parseCsv, tableNameFromFilename } from "./csv";
import { statementsZumImport } from "./cypher-script";
import type { DocumentRecord } from "./db/schema";
import { leseDatei } from "./documents";
import { ValidationError } from "./errors";
import { ZEICHEN_JE_SEITE, ZEILEN_JE_SEITE } from "./extract";
import {
  graphArtefaktPfad,
  graphElemente,
  leseGraphDaten,
  type GraphDaten,
} from "./graph-extraktion";
import { GRAPH_DOKUMENT_ENDUNGEN, istGraphDokument } from "./graph-ontologie";
import { deleteGraph, describeGraph, importGraphDaten, importStatements } from "./graphstore";
import {
  describeSchema,
  dropTable,
  listTables,
  loadDatabase,
  replaceTable,
  saveDatabase,
} from "./sqlstore";
import { loescheDokumentChunks } from "./vector";

/**
 * Was beim Einspielen und Entfernen je Sammlungstyp mit der Datei passiert.
 *
 *   sql     CSV  -> Tabelle in der SQLite-Datei der Sammlung (Blob)
 *   graph   Cypher-Skript -> Statements in den FalkorDB-Graph der Sammlung
 *   vector  bleibt in workflows/ingest.ts (Extraktion bzw. MP3-Transkription,
 *           Zerlegung, Pinecone)
 *
 * Reine Verarbeitungsfunktionen: kein Request, keine Sperre, kein Kontingent.
 * Das erledigen die Aufrufer — der Ablauf in workflows/ingest.ts und die
 * Loeschroute. Was hier steht, laesst sich damit gegen eine In-Memory-SQLite
 * und gemockte Speicher pruefen.
 *
 * "Seiten" gibt es bei CSV und Cypher nicht. Fuer die Kontingentpruefung
 * braucht es trotzdem eine vergleichbare Groesse; sie wird nach demselben
 * Massstab geschaetzt wie bei XLSX (Zeilen je Seite) und DOCX (Zeichen je
 * Seite) in lib/extract.ts.
 */

export type IngestErgebnis = {
  /** Zeilen (sql) bzw. Statements (graph) — landet als chunkCount am Dokument. */
  units: number;
  /** Geschaetzte Seiten fuer das Kontingent. */
  pageCount: number;
  schema: CollectionSchema;
};

/**
 * Prueft die Dateiendung gegen den Sammlungstyp.
 *
 * Fuer Dokumentensammlungen ist das nur die erste Huerde; danach prueft
 * `detectKind` zusaetzlich den Inhaltstyp (PDF, DOCX, XLSX, MP3). Fuer CSV und Cypher ist die Endung
 * die einzige verlaessliche Angabe — Browser melden fuer beide je nach System
 * einen leeren oder generischen Inhaltstyp.
 */
export function assertAllowedExtension(
  kind: CollectionKind,
  filename: string,
  options: { extraktion?: boolean } = {},
): void {
  const lower = filename.toLowerCase();
  const erlaubt =
    kind === "graph" && options.extraktion
      ? [...KIND_EXTENSIONS.graph, ...GRAPH_DOKUMENT_ENDUNGEN]
      : KIND_EXTENSIONS[kind];

  if (!erlaubt.some((endung) => lower.endsWith(endung))) {
    throw new ValidationError(
      `Fuer eine ${KIND_LABEL[kind]}-Sammlung sind nur ${erlaubt.join(", ")} zulaessig.`,
    );
  }
}

/** Seitenmass einer CSV: Zeilen je Seite wie bei Tabellenblaettern. */
export function seitenAusZeilen(zeilen: number): number {
  return Math.max(Math.ceil(zeilen / ZEILEN_JE_SEITE), zeilen > 0 ? 1 : 0);
}

/** Seitenmass eines Skripts: Zeichen je Seite wie bei DOCX. */
export function seitenAusZeichen(zeichen: number): number {
  return Math.max(Math.ceil(zeichen / ZEICHEN_JE_SEITE), zeichen > 0 ? 1 : 0);
}

/**
 * Dokumente, deren Tabelle durch diesen Upload ersetzt wird.
 *
 * Eine Datei je Tabelle: "umsatz.csv" ein zweites Mal hochzuladen ersetzt die
 * Tabelle `umsatz`, und der fruehere Satz muss weichen — sonst zeigte die
 * Uebersicht zwei Dateien fuer eine Tabelle, und die Zaehler stimmten nicht
 * mehr. Laufende oder wartende Saetze bleiben unberuehrt: Sie ersetzen ihrerseits,
 * sobald sie durch sind.
 */
export function ersetzteDokumente(
  dokumente: DocumentRecord[],
  filename: string,
  eigeneDocId: string,
): DocumentRecord[] {
  const tabelle = tableNameFromFilename(filename);
  return dokumente.filter(
    (satz) =>
      satz.id !== eigeneDocId &&
      (satz.status === "fertig" || satz.status === "fehler") &&
      tableNameFromFilename(satz.filename) === tabelle,
  );
}

// --- Tabellen (sql) ---------------------------------------------------------

export type SqlEingabe = {
  userId: string;
  collectionId: string;
  buffer: ArrayBuffer;
  filename: string;
  /**
   * Wird nach dem Lesen der CSV und VOR dem Schreiben aufgerufen. Hier haengt
   * der Ablauf die Seitenpruefung ein: Sie muss die Zeilenzahl kennen, darf
   * aber erst greifen, bevor etwas in die Datenbank geschrieben ist.
   */
  vorSchreiben?: (pageCount: number) => void;
};

/**
 * CSV einlesen und als Tabelle in die SQLite-Datei der Sammlung schreiben.
 *
 * Lesen, aendern, zurueckschreiben — die Datei wird als Ganzes bewegt. Der
 * Aufrufer muss dafuer sorgen, dass nicht zwei Vorgaenge gleichzeitig an
 * derselben Sammlung arbeiten (Sperre im Ablauf). Wiederholbar: `replaceTable`
 * ersetzt eine vorhandene Tabelle gleichen Namens vollstaendig.
 */
export async function ingestSql(
  eingabe: SqlEingabe,
): Promise<IngestErgebnis & { replacedTable: string }> {
  const parsed = parseCsv(eingabe.buffer);
  const tabelle = tableNameFromFilename(eingabe.filename);
  const pageCount = seitenAusZeilen(parsed.rows.length);

  eingabe.vorSchreiben?.(pageCount);

  checkIngestionCapacity();
  const db = await loadDatabase(eingabe.userId, eingabe.collectionId);
  try {
    checkIngestionCapacity();
    replaceTable(db, tabelle, parsed.columns, parsed.rows);
    checkIngestionCapacity();
    await saveDatabase(eingabe.userId, eingabe.collectionId, db);

    const schema = describeSchema(db);
    checkIngestionCapacity();
    await setzeSammlungsSchema(eingabe.userId, eingabe.collectionId, schema);

    return { units: parsed.rows.length, pageCount, schema, replacedTable: tabelle };
  } finally {
    db.close();
  }
}

// --- Graph ------------------------------------------------------------------

export type GraphEingabe = {
  userId: string;
  collectionId: string;
  buffer: ArrayBuffer;
  /**
   * Die uebrigen, fertig eingespielten Skripte der Sammlung. Schlaegt der
   * Import fehl, wird der Graph aus genau diesen neu aufgebaut.
   */
  uebrige: DocumentRecord[];
  vorSchreiben?: (pageCount: number) => void;
};

function skriptAusPuffer(buffer: ArrayBuffer): string {
  // BOM entfernen — sonst steht er vor dem ersten Statement.
  return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
}

/**
 * Cypher-Skript in den Graphen der Sammlung einspielen.
 *
 * Einzelne Statements lassen sich nicht rueckgaengig machen. Bricht der Import
 * in der Mitte ab, bliebe ein halb eingespieltes Skript im Graphen; deshalb
 * wird er dann aus den uebrigen Skripten neu aufgebaut, bevor der Fehler
 * weitergereicht wird.
 */
export async function ingestGraph(eingabe: GraphEingabe): Promise<IngestErgebnis> {
  const skript = skriptAusPuffer(eingabe.buffer);
  const statements = statementsZumImport(skript);
  const pageCount = seitenAusZeichen(skript.length);

  eingabe.vorSchreiben?.(pageCount);

  try {
    checkIngestionCapacity();
    await importStatements(eingabe.collectionId, statements);
  } catch (error) {
    // A lost lease must not start a destructive rebuild alongside a new owner.
    checkIngestionCapacity();
    await rebuildGraph(eingabe.userId, eingabe.collectionId, eingabe.uebrige);
    throw error;
  }

  checkIngestionCapacity();
  const schema = await describeGraph(eingabe.collectionId);
  checkIngestionCapacity();
  await setzeSammlungsSchema(eingabe.userId, eingabe.collectionId, schema);

  return { units: statements.length, pageCount, schema };
}

export type GraphDatenEingabe = {
  userId: string;
  collectionId: string;
  daten: GraphDaten;
  /** Die uebrigen fertigen Dokumente der Sammlung — fuer den Neuaufbau bei einem Fehler. */
  uebrige: DocumentRecord[];
};

/**
 * Extraktionsergebnis eines Dokuments in den Graphen einspielen — das
 * Gegenstueck zu ingestGraph fuer Dokumente statt Skripte. Das Artefakt
 * `_graph.json` muss vorher liegen; der Aufrufer schreibt es, damit ein
 * Neuaufbau nach diesem Import dasselbe Ergebnis wiederfindet.
 */
export async function ingestGraphDaten(eingabe: GraphDatenEingabe): Promise<IngestErgebnis> {
  try {
    checkIngestionCapacity();
    await importGraphDaten(eingabe.collectionId, eingabe.daten);
  } catch (error) {
    checkIngestionCapacity();
    await rebuildGraph(eingabe.userId, eingabe.collectionId, eingabe.uebrige);
    throw error;
  }

  checkIngestionCapacity();
  const schema = await describeGraph(eingabe.collectionId);
  checkIngestionCapacity();
  await setzeSammlungsSchema(eingabe.userId, eingabe.collectionId, schema);

  return { units: graphElemente(eingabe.daten), pageCount: 0, schema };
}

/**
 * Baut den Graphen aus den genannten Dokumenten neu auf — in der Reihenfolge
 * ihres Hochladens, weil spaetere Skripte auf Knoten frueherer verweisen
 * koennen. Skripte werden erneut eingespielt, extrahierte Dokumente aus ihrem
 * `_graph.json` — das Modell wird dafuer nie erneut gefragt. Haelt das Schema
 * danach fest; ohne Dokumente wird es `null`.
 */
export async function rebuildGraph(
  userId: string,
  collectionId: string,
  dokumente: DocumentRecord[],
): Promise<CollectionSchema | null> {
  checkIngestionCapacity();
  await deleteGraph(collectionId);

  const reihenfolge = [...dokumente].sort(
    (a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime(),
  );

  let eingespielt = 0;
  for (const satz of reihenfolge) {
    checkIngestionCapacity();
    const extrahiert = istGraphDokument(satz.filename);
    const strom = await leseDatei(extrahiert ? graphArtefaktPfad(satz.blobPath) : satz.blobPath);
    // Eine fehlende Datei kann nicht wiederhergestellt werden; der Rest soll
    // deshalb nicht ebenfalls fehlen.
    if (!strom) continue;

    const inhalt = skriptAusPuffer(await new Response(strom).arrayBuffer());
    checkIngestionCapacity();
    if (extrahiert) await importGraphDaten(collectionId, leseGraphDaten(inhalt));
    else await importStatements(collectionId, statementsZumImport(inhalt));
    eingespielt += 1;
  }

  checkIngestionCapacity();
  const schema = eingespielt > 0 ? await describeGraph(collectionId) : null;
  checkIngestionCapacity();
  await setzeSammlungsSchema(userId, collectionId, schema);
  return schema;
}

// --- Entfernen --------------------------------------------------------------

export type EntfernenEingabe = {
  kind: CollectionKind;
  userId: string;
  collectionId: string;
  /** Der zu entfernende Satz. */
  satz: DocumentRecord;
  /** Die uebrigen fertigen Saetze der Sammlung — fuer den Neuaufbau eines Graphen. */
  uebrige: DocumentRecord[];
};

/**
 * Raeumt die Spuren eines Dokuments im typabhaengigen Speicher ab.
 *
 * Nur den Speicher — Datei und Metadatensatz entfernt der Aufrufer danach
 * (erst Speicher, dann Zeile: bricht es ab, bleibt der Satz sichtbar und der
 * Vorgang wiederholbar). Ein Satz, der nie fertig wurde, hat im Speicher
 * nichts hinterlassen; bei Tabellen waere ein `DROP TABLE` sogar gefaehrlich,
 * weil ein fruehrer gleichnamiger Upload die Tabelle tatsaechlich fuellt.
 */
export async function entferneDokumentJeTyp(eingabe: EntfernenEingabe): Promise<void> {
  const { kind, userId, collectionId, satz, uebrige } = eingabe;

  switch (kind) {
    case "vector":
      await loescheDokumentChunks(collectionId, satz.id, satz.chunkCount);
      return;

    case "sql": {
      if (satz.status !== "fertig") return;

      const db = await loadDatabase(userId, collectionId);
      try {
        dropTable(db, tableNameFromFilename(satz.filename));
        await saveDatabase(userId, collectionId, db);

        const schema = listTables(db).length > 0 ? describeSchema(db) : null;
        await setzeSammlungsSchema(userId, collectionId, schema);
      } finally {
        db.close();
      }
      return;
    }

    case "graph": {
      if (satz.status !== "fertig") return;
      await rebuildGraph(userId, collectionId, uebrige.filter((d) => d.id !== satz.id));
      return;
    }
  }
}
