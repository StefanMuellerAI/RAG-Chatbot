import { del, get, list, put } from "@vercel/blob";
import { requireEnv } from "./env";

/**
 * Dokument-Verwaltung auf Vercel Blob.
 *
 * Pro Dokument liegen zwei Objekte im Store:
 *   files/<docId>/<dateiname>   die Originaldatei
 *   documents/<docId>.json      der Metadatensatz
 *
 * Beides mit `access: "private"` — die Originale sollen nicht ueber eine
 * erratene URL im Netz stehen. Der Download im Admin laeuft deshalb ueber eine
 * eigene, authentifizierte Route.
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
};

const META_PREFIX = "documents/";
export const FILE_PREFIX = "files/";

function assertConfigured(): void {
  requireEnv("BLOB_READ_WRITE_TOKEN");
}

export function metaPath(docId: string): string {
  return `${META_PREFIX}${docId}.json`;
}

export async function saveDocument(record: DocumentRecord): Promise<void> {
  assertConfigured();
  await put(metaPath(record.id), JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    // Der Pfad ist der Schluessel — ein Zufallssuffix wuerde ihn unauffindbar machen.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  assertConfigured();

  const records: DocumentRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: META_PREFIX, cursor, limit: 250 });
    const batch = await Promise.all(page.blobs.map((blob) => readRecord(blob.url)));
    records.push(...batch.filter((record): record is DocumentRecord => record !== null));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function getDocument(docId: string): Promise<DocumentRecord | null> {
  assertConfigured();
  return readRecord(metaPath(docId));
}

async function readRecord(urlOrPath: string): Promise<DocumentRecord | null> {
  const result = await get(urlOrPath, { access: "private" });
  if (!result) return null;

  try {
    return JSON.parse(await new Response(result.stream).text()) as DocumentRecord;
  } catch {
    // Ein beschaedigter Metadatensatz darf nicht die ganze Liste kippen.
    return null;
  }
}

/** Laedt die Originaldatei aus dem Blob-Store. */
export async function readFile(path: string): Promise<ReadableStream | null> {
  assertConfigured();
  const result = await get(path, { access: "private" });
  return result ? (result.stream as ReadableStream) : null;
}

export async function deleteDocument(record: DocumentRecord): Promise<void> {
  assertConfigured();
  await del([metaPath(record.id), record.filePath]);
}

/** Raeumt saemtliche Dateien und Metadaten ab. */
export async function deleteAllDocuments(): Promise<number> {
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

  return removed;
}
