import { del, get, list, put } from "@vercel/blob";
import { requireEnv } from "./env";
import { getRedis } from "./redis";

/**
 * Dokument-Verwaltung.
 *
 * Die Originaldatei liegt in Vercel Blob unter
 * `files/<collectionId>/<uuid>/<dateiname>`, mit `access: "private"` — die
 * Originale sollen nicht ueber eine erratene URL im Netz stehen. Der Download
 * laeuft deshalb ueber eine eigene, authentifizierte Route.
 *
 * Metadaten in Redis:
 *   documents:<collectionId>  Hash  docId -> DocumentRecord
 *   documents:byId            Hash  docId -> collectionId   (fuer Download/Loeschen per ID)
 *
 * Zusaetzlich wird jeder Datensatz als `documents/<docId>.json` in Blob
 * gesichert. Aus der Zeit vor den Sammlungen kann noch der alte Hash
 * `documents` existieren; lib/collections.ts ueberfuehrt ihn einmalig.
 */

export type DocumentRecord = {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  chunkCount: number;
  /** Pfad der Originaldatei im Blob-Store. */
  filePath: string;
  collectionId: string;
};

const META_PREFIX = "documents/";
export const FILE_PREFIX = "files/";

const LEGACY_INDEX_KEY = "documents";
const BY_ID_KEY = "documents:byId";

/** Sammlung, in die Dokumente aus der Zeit vor den Sammlungen wandern. */
export const LEGACY_COLLECTION_ID = "standard";

function indexKey(collectionId: string): string {
  return `documents:${collectionId}`;
}

function assertConfigured(): void {
  requireEnv("BLOB_READ_WRITE_TOKEN");
}

export function metaPath(docId: string): string {
  return `${META_PREFIX}${docId}.json`;
}

/** Praefix, unter dem alle Originaldateien einer Sammlung liegen. */
export function filePathPrefix(collectionId: string): string {
  return `${FILE_PREFIX}${collectionId}/`;
}

function parseRecord(value: unknown): DocumentRecord | null {
  try {
    const record = (typeof value === "string" ? JSON.parse(value) : value) as Partial<DocumentRecord>;
    if (!record || typeof record.id !== "string" || typeof record.filePath !== "string") return null;
    return {
      ...(record as DocumentRecord),
      // Alte Datensaetze kennen keine Sammlung — sie gehoeren zur Standardsammlung.
      collectionId: typeof record.collectionId === "string" ? record.collectionId : LEGACY_COLLECTION_ID,
    };
  } catch {
    return null;
  }
}

function parseAll(values: Record<string, unknown> | null): DocumentRecord[] {
  if (!values) return [];
  return Object.values(values)
    .map(parseRecord)
    .filter((record): record is DocumentRecord => record !== null);
}

function sortiert(records: DocumentRecord[]): DocumentRecord[] {
  return records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

async function writeIndex(record: DocumentRecord): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.hset(indexKey(record.collectionId), { [record.id]: JSON.stringify(record) }),
    redis.hset(BY_ID_KEY, { [record.id]: record.collectionId }),
  ]);
}

async function writeBackup(record: DocumentRecord): Promise<void> {
  await put(metaPath(record.id), JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    // Der Pfad ist der Schluessel — ein Zufallssuffix wuerde ihn unauffindbar machen.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function saveDocument(record: DocumentRecord): Promise<void> {
  assertConfigured();
  await Promise.all([writeIndex(record), writeBackup(record)]);
}

export async function listDocuments(collectionId: string): Promise<DocumentRecord[]> {
  const index = await getRedis().hgetall<Record<string, unknown>>(indexKey(collectionId));
  return sortiert(parseAll(index));
}

export async function getDocument(docId: string): Promise<DocumentRecord | null> {
  assertConfigured();
  const redis = getRedis();

  const collectionId = await redis.hget<string>(BY_ID_KEY, docId);
  if (collectionId) {
    const raw = await redis.hget<unknown>(indexKey(collectionId), docId);
    if (raw) return parseRecord(raw);
  }

  // Nicht im Index: vielleicht existiert noch die Blob-Sicherung. Dann den
  // Index nachziehen, damit der naechste Zugriff ohne Blob auskommt.
  const fromBlob = await readBlobRecord(metaPath(docId));
  if (fromBlob) await writeIndex(fromBlob);
  return fromBlob;
}

async function readBlobRecord(urlOrPath: string): Promise<DocumentRecord | null> {
  const result = await get(urlOrPath, { access: "private" });
  if (!result) return null;
  // Ein beschaedigter Metadatensatz darf nicht die ganze Liste kippen.
  return parseRecord(await new Response(result.stream).text());
}

/** Laedt die Originaldatei aus dem Blob-Store. */
export async function readFile(path: string): Promise<ReadableStream | null> {
  assertConfigured();
  const result = await get(path, { access: "private" });
  return result ? (result.stream as ReadableStream) : null;
}

export async function deleteDocument(record: DocumentRecord): Promise<void> {
  assertConfigured();
  const redis = getRedis();
  await Promise.all([
    redis.hdel(indexKey(record.collectionId), record.id),
    redis.hdel(BY_ID_KEY, record.id),
    del([metaPath(record.id), record.filePath]),
  ]);
}

/** Entfernt eine einzelne Originaldatei — fuer das Aufraeumen nach Fehlern. */
export async function deleteFile(path: string): Promise<void> {
  assertConfigured();
  await del(path);
}

/** Loescht alle Dokumente einer Sammlung (Dateien, Sicherungen, Index). */
export async function deleteAllDocumentsIn(collectionId: string): Promise<number> {
  assertConfigured();
  const redis = getRedis();

  const records = await listDocuments(collectionId);
  const pfade = records.flatMap((record) => [metaPath(record.id), record.filePath]);
  for (let i = 0; i < pfade.length; i += 100) {
    await del(pfade.slice(i, i + 100));
  }

  await redis.del(indexKey(collectionId));
  if (records.length > 0) await redis.hdel(BY_ID_KEY, ...records.map((record) => record.id));
  return records.length;
}

/**
 * Raeumt saemtliche Dateien und Metadaten aller Sammlungen ab — der
 * Admin-Notausgang. Blob wird ueber Praefixe geleert, damit auch Reste ohne
 * Index verschwinden.
 */
export async function deleteAllDocumentsEverywhere(collectionIds: string[]): Promise<number> {
  assertConfigured();

  let removed = 0;
  for (const prefix of [META_PREFIX, FILE_PREFIX]) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 250 });
      if (page.blobs.length > 0) {
        await del(page.blobs.map((blob) => blob.url));
        removed += page.blobs.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  const keys = [LEGACY_INDEX_KEY, BY_ID_KEY, ...collectionIds.map(indexKey)];
  await getRedis().del(...keys);
  return removed;
}

// ---------------------------------------------------------------------------
// Migration aus der Zeit vor den Sammlungen
// ---------------------------------------------------------------------------

/** Dokumente aus dem alten Hash bzw. den Blob-Sicherungen, noch ohne Sammlung. */
async function readLegacyDocuments(): Promise<DocumentRecord[]> {
  const legacy = await getRedis().hgetall<Record<string, unknown>>(LEGACY_INDEX_KEY);
  const fromRedis = parseAll(legacy);
  if (fromRedis.length > 0) return fromRedis;

  assertConfigured();
  const records: DocumentRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: META_PREFIX, cursor, limit: 250 });
    const batch = await Promise.all(page.blobs.map((blob) => readBlobRecord(blob.url)));
    records.push(...batch.filter((record): record is DocumentRecord => record !== null));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return records;
}

export async function hasLegacyDocuments(): Promise<boolean> {
  return (await readLegacyDocuments()).length > 0;
}

/** Ueberfuehrt alte Dokumente in die genannte Sammlung und entfernt den alten Hash. */
export async function migrateLegacyDocuments(collectionId: string): Promise<number> {
  const records = await readLegacyDocuments();
  for (const record of records) {
    const migrated: DocumentRecord = { ...record, collectionId };
    await Promise.all([writeIndex(migrated), writeBackup(migrated)]);
  }
  await getRedis().del(LEGACY_INDEX_KEY);
  return records.length;
}
