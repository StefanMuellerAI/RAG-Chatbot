import { chunkBlocks } from "./chunk";
import { KIND_EXTENSIONS } from "./collection-kinds";
import { updateCollectionSchema, type Collection } from "./collections";
import { parseCsv, tableNameFromFilename } from "./csv";
import { splitStatements } from "./cypher-script";
import { deleteDocument, listDocuments, readFile, type DocumentRecord } from "./documents";
import { ValidationError } from "./errors";
import { extractBlocks } from "./extract";
import { deleteGraph, describeGraph, importStatements } from "./graphstore";
import { describeSchema, dropTable, listTables, loadDatabase, replaceTable, saveDatabase } from "./sqlstore";
import { deleteDocumentChunks, upsertChunks } from "./vector";

/**
 * Was beim Hochladen und Loeschen je Sammlungstyp passiert.
 *
 *   vector  Text -> Abschnitte -> Upstash-Namespace
 *   sql     CSV  -> Tabelle in der SQLite-Datei der Sammlung
 *   graph   Cypher-Skript -> Statements in den FalkorDB-Graph der Sammlung
 */

export type IngestResult = {
  /** Abschnitte, Zeilen oder Statements. */
  units: number;
  /** Dokumente, die durch diesen Upload ersetzt wurden (gleicher Tabellenname). */
  replaced: DocumentRecord[];
};

export function assertAllowedExtension(collection: Collection, filename: string): void {
  const lower = filename.toLowerCase();
  const erlaubt = KIND_EXTENSIONS[collection.kind];
  if (!erlaubt.some((ext) => lower.endsWith(ext))) {
    throw new ValidationError(
      `Fuer eine ${collection.kind === "sql" ? "Tabellen" : collection.kind === "graph" ? "Graph" : "Dokumenten"}-Sammlung ` +
        `sind nur ${erlaubt.join(", ")} zulaessig.`,
    );
  }
}

export async function ingest(
  collection: Collection,
  docId: string,
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string | undefined,
): Promise<IngestResult> {
  switch (collection.kind) {
    case "vector":
      return ingestVector(collection, docId, buffer, filename, mimeType);
    case "sql":
      return ingestSql(collection, buffer, filename);
    case "graph":
      return ingestGraph(collection, buffer);
  }
}

/** Rueckabwicklung, wenn der Metadatensatz nach erfolgreichem Import nicht gespeichert werden konnte. */
export async function rollbackIngest(collection: Collection, docId: string, filename: string): Promise<void> {
  switch (collection.kind) {
    case "vector":
      await deleteDocumentChunks(collection.namespace, docId);
      return;
    case "sql": {
      const db = await loadDatabase(collection.id);
      dropTable(db, tableNameFromFilename(filename));
      await saveDatabase(collection.id, db);
      await updateCollectionSchema(collection, describeSchema(db));
      return;
    }
    case "graph":
      await rebuildGraph(collection, docId);
      return;
  }
}

/** Entfernt ein Dokument samt seiner Spuren im typabhaengigen Speicher. */
export async function removeDocument(collection: Collection, record: DocumentRecord): Promise<number> {
  switch (collection.kind) {
    case "vector": {
      const deleted = await deleteDocumentChunks(collection.namespace, record.id);
      await deleteDocument(record);
      return deleted;
    }
    case "sql": {
      const db = await loadDatabase(collection.id);
      dropTable(db, tableNameFromFilename(record.filename));
      await saveDatabase(collection.id, db);
      await deleteDocument(record);
      await updateCollectionSchema(collection, listTables(db).length > 0 ? describeSchema(db) : undefined);
      return record.chunkCount;
    }
    case "graph": {
      await deleteDocument(record);
      await rebuildGraph(collection, record.id);
      return record.chunkCount;
    }
  }
}

// ---------------------------------------------------------------------------

async function ingestVector(
  collection: Collection,
  docId: string,
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string | undefined,
): Promise<IngestResult> {
  const blocks = await extractBlocks(buffer, filename, mimeType);
  const chunks = chunkBlocks(blocks);
  if (chunks.length === 0) {
    throw new ValidationError(
      `Aus "${filename}" liess sich kein Text gewinnen. ` +
        `Bei PDFs ist das meist ein Scan ohne Texterkennung — eine per OCR durchsuchbare Fassung waere hier noetig.`,
    );
  }
  await upsertChunks(collection.namespace, docId, filename, chunks);
  return { units: chunks.length, replaced: [] };
}

async function ingestSql(collection: Collection, buffer: ArrayBuffer, filename: string): Promise<IngestResult> {
  const parsed = parseCsv(buffer);
  const table = tableNameFromFilename(filename);

  const db = await loadDatabase(collection.id);
  replaceTable(db, table, parsed.columns, parsed.rows);
  await saveDatabase(collection.id, db);
  await updateCollectionSchema(collection, describeSchema(db));

  // Eine Datei je Tabelle: ein frueherer Upload mit demselben Tabellennamen weicht.
  const vorhanden = await listDocuments(collection.id);
  const replaced = vorhanden.filter((record) => tableNameFromFilename(record.filename) === table);
  for (const record of replaced) await deleteDocument(record);

  return { units: parsed.rows.length, replaced };
}

async function ingestGraph(collection: Collection, buffer: ArrayBuffer): Promise<IngestResult> {
  const script = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  const statements = splitStatements(script);

  try {
    await importStatements(collection.id, statements);
  } catch (error) {
    // Halb eingespielte Skripte hinterlassen einen inkonsistenten Graphen —
    // zurueck auf den Stand der bereits vorhandenen Dateien.
    await rebuildGraph(collection, null);
    throw error;
  }

  await updateCollectionSchema(collection, await describeGraph(collection.id));
  return { units: statements.length, replaced: [] };
}

/**
 * Baut den Graphen aus allen Skripten der Sammlung neu auf — ohne das
 * Dokument `ohneDocId`. Noetig, weil sich einzelne Statements nicht
 * rueckgaengig machen lassen.
 */
async function rebuildGraph(collection: Collection, ohneDocId: string | null): Promise<void> {
  await deleteGraph(collection.id);

  const uebrig = (await listDocuments(collection.id)).filter((record) => record.id !== ohneDocId);
  for (const record of uebrig.reverse()) {
    const stream = await readFile(record.filePath);
    if (!stream) continue;
    const text = await new Response(stream).text();
    await importStatements(collection.id, splitStatements(text.replace(/^\uFEFF/, "")));
  }

  await updateCollectionSchema(collection, uebrig.length > 0 ? await describeGraph(collection.id) : undefined);
}
