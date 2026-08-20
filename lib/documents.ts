import { del, get, list, put } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { collections, documents } from "./db/schema";
import type { DocumentRecord, DocumentStatus } from "./db/schema";
import { requireEnv } from "./env";
import { NotFoundError } from "./errors";

/**
 * Dokumente: Metadaten in Postgres, Originaldateien in Vercel Blob.
 *
 * Der Vorgaenger legte je Dokument einen JSON-Blob ab und las beim Auflisten
 * einen davon pro Dokument. Bei 300.000 Dokumenten waeren das 300.000
 * HTTP-Aufrufe fuer eine Uebersichtsseite. Metadaten gehoeren in eine Datenbank,
 * die filtern, zaehlen und sortieren kann; im Blob-Store bleibt nur die Datei.
 *
 * Die Blob-Pfade sind mandantenpraefigiert:
 *
 *     files/<userId>/<collectionId>/<docId>/<dateiname>
 *
 * Das ist nicht bloss Ordnung. Der Pfad kommt beim Direkt-Upload vom Browser,
 * und die Ausgabe des Upload-Tokens prueft, dass er mit dem Praefix des
 * aufrufenden Nutzers beginnt. Ohne diese Struktur gaebe es keinen Anhaltspunkt,
 * an dem sich das pruefen liesse.
 */

export const FILE_PREFIX = "files/";

function assertConfigured(): void {
  requireEnv("BLOB_READ_WRITE_TOKEN");
}

/** Praefix aller Dateien eines Nutzers. Grundlage der Pfadpruefung. */
export function nutzerPraefix(userId: string): string {
  return `${FILE_PREFIX}${userId}/`;
}

export function sammlungsPraefix(userId: string, collectionId: string): string {
  return `${nutzerPraefix(userId)}${collectionId}/`;
}

export function blobPfad(
  userId: string,
  collectionId: string,
  docId: string,
  dateiname: string,
): string {
  return `${sammlungsPraefix(userId, collectionId)}${docId}/${dateiname}`;
}

/**
 * Gehoert dieser Pfad dem Nutzer?
 *
 * Wird bei der Ausgabe des Upload-Tokens aufgerufen. Ohne diese Pruefung
 * koennte ein angemeldeter Nutzer in den Ablagebereich eines anderen schreiben.
 */
export function pfadGehoertNutzer(pfad: string, userId: string): boolean {
  // `..` wuerde sich sonst aus dem eigenen Praefix herausbewegen.
  if (pfad.includes("..")) return false;
  return pfad.startsWith(nutzerPraefix(userId));
}

// --- Metadaten --------------------------------------------------------------

export type NeuesDokument = {
  id: string;
  collectionId: string;
  userId: string;
  filename: string;
  contentType: string;
  blobPath: string;
  sizeBytes: number;
};

/**
 * Legt den Metadatensatz an, bevor die Datei hochgeladen ist.
 *
 * Reihenfolge mit Absicht: Der Satz existiert zuerst, und die Ausgabe des
 * Upload-Tokens verlangt, dass er existiert. Damit gibt es keinen Upload ohne
 * vorher geprueftes Kontingent.
 *
 * Der Zaehler in der Sammlung waechst dabei mit — auch fuer noch nicht
 * abgeschlossene Uploads. Das ist die vorsichtigere Richtung: wer 25 Dateien
 * gleichzeitig ablegt, soll damit nicht 25-mal dieselbe freie Restmenge
 * vorfinden. Gescheiterte Uploads raeumt lib/aufraeumen.ts wieder ab.
 */
export async function legeDokumentAn(neu: NeuesDokument): Promise<DocumentRecord> {
  const db = getDb();

  const [angelegt] = await db.insert(documents).values(neu).returning();

  await db
    .update(collections)
    .set({
      documentCount: sql`${collections.documentCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(collections.id, neu.collectionId));

  return angelegt;
}

/**
 * Ein Dokument des Nutzers.
 *
 * Die Nutzer-ID steht in der WHERE-Klausel und nicht in einer Pruefung danach.
 * Eine fremde ID liefert damit dasselbe Ergebnis wie eine erfundene: nichts.
 */
export async function ladeDokument(userId: string, docId: string): Promise<DocumentRecord> {
  const satz = await getDb().query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.userId, userId)),
  });

  if (!satz) throw new NotFoundError("Das Dokument");
  return satz;
}

export async function ladeDokumenteDerSammlung(
  userId: string,
  collectionId: string,
): Promise<DocumentRecord[]> {
  return getDb()
    .select()
    .from(documents)
    .where(and(eq(documents.collectionId, collectionId), eq(documents.userId, userId)))
    .orderBy(sql`${documents.uploadedAt} desc`);
}

export async function setzeDokumentStatus(
  docId: string,
  status: DocumentStatus,
  zusatz: { error?: string | null; workflowRunId?: string } = {},
): Promise<void> {
  await getDb()
    .update(documents)
    .set({
      status,
      error: zusatz.error ?? null,
      ...(zusatz.workflowRunId ? { workflowRunId: zusatz.workflowRunId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, docId));
}

/**
 * Schliesst die Verarbeitung ab: Seiten- und Abschnittszahl festhalten und die
 * Zaehler der Sammlung fortschreiben.
 *
 * Die Zaehler werden als `spalte + wert` geschrieben und nicht gelesen, im
 * Speicher addiert und zurueckgeschrieben. Bei parallelen Ingestionen derselben
 * Sammlung wuerde das Zweite das Erste ueberschreiben.
 */
export async function schliesseDokumentAb(
  docId: string,
  collectionId: string,
  seiten: number,
  abschnitte: number,
): Promise<void> {
  const db = getDb();

  await db
    .update(documents)
    .set({
      status: "fertig",
      error: null,
      pageCount: seiten,
      chunkCount: abschnitte,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, docId));

  await db
    .update(collections)
    .set({
      pageCount: sql`${collections.pageCount} + ${seiten}`,
      chunkCount: sql`${collections.chunkCount} + ${abschnitte}`,
      updatedAt: new Date(),
    })
    .where(eq(collections.id, collectionId));
}

/**
 * Entfernt den Metadatensatz und schreibt die Zaehler zurueck.
 *
 * Die Abschnitte in Pinecone und die Datei im Blob-Store raeumt der Aufrufer;
 * die Reihenfolge dort ist bewusst nicht hier festgelegt (siehe die Loeschroute).
 */
export async function entferneDokumentSatz(satz: DocumentRecord): Promise<void> {
  const db = getDb();

  await db.delete(documents).where(eq(documents.id, satz.id));

  await db
    .update(collections)
    .set({
      documentCount: sql`greatest(${collections.documentCount} - 1, 0)`,
      pageCount: sql`greatest(${collections.pageCount} - ${satz.pageCount}, 0)`,
      chunkCount: sql`greatest(${collections.chunkCount} - ${satz.chunkCount}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(collections.id, satz.collectionId));
}

// --- Dateien ----------------------------------------------------------------

/** Laedt die Originaldatei aus dem Blob-Store. */
export async function leseDatei(pfad: string): Promise<ReadableStream | null> {
  assertConfigured();
  const ergebnis = await get(pfad, { access: "private" });
  return ergebnis ? (ergebnis.stream as ReadableStream) : null;
}

export async function loescheDatei(pfad: string): Promise<void> {
  assertConfigured();
  await del(pfad);
}

/**
 * Raeumt alle Dateien unterhalb eines Praefixes ab.
 *
 * Wird beim Loeschen einer Sammlung gebraucht: dort sind die einzelnen Pfade
 * nicht mehr von Interesse, das Praefix genuegt.
 */
export async function loescheUnterPraefix(praefix: string): Promise<number> {
  assertConfigured();

  let entfernt = 0;
  let cursor: string | undefined;

  do {
    const seite = await list({ prefix: praefix, cursor, limit: 250 });
    if (seite.blobs.length > 0) {
      await del(seite.blobs.map((blob) => blob.url));
      entfernt += seite.blobs.length;
    }
    cursor = seite.hasMore ? seite.cursor : undefined;
  } while (cursor);

  return entfernt;
}

/** Schreibt eine Datei serverseitig — nur fuer die Migration von Altdaten. */
export async function schreibeDatei(
  pfad: string,
  inhalt: Buffer | string,
  contentType: string,
): Promise<void> {
  assertConfigured();
  await put(pfad, inhalt, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}
