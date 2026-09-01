import { NextResponse } from "next/server";
import { ValidationError, errorResponse, readJson, requireSession } from "@/lib/api";
import { assertCollectionAccess } from "@/lib/collections";
import {
  deleteDocument,
  deleteFile,
  filePathPrefix,
  listDocuments,
  readFile,
  saveDocument,
  type DocumentRecord,
} from "@/lib/documents";
import { UnsupportedFileError, detectKind } from "@/lib/extract";
import { assertAllowedExtension, ingest, rollbackIngest } from "@/lib/ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Liste der Dokumente einer Sammlung (`?collectionId=`). */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const collectionId = new URL(request.url).searchParams.get("collectionId");
    const collection = await assertCollectionAccess(collectionId, session);
    return NextResponse.json({ documents: await listDocuments(collection.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Verarbeitet eine zuvor hochgeladene Datei je nach Sammlungstyp: Text in
 * Abschnitte und den Vektor-Namespace, CSV in eine SQLite-Tabelle oder ein
 * Cypher-Skript in den Graphen. Danach wird der Metadatensatz abgelegt.
 */
export async function POST(request: Request) {
  const { blobPath, filename, contentType, collectionId } = await readJson<{
    blobPath: unknown;
    filename: unknown;
    contentType: unknown;
    collectionId: unknown;
  }>(request);

  if (typeof blobPath !== "string" || typeof filename !== "string") {
    return NextResponse.json({ error: "blobPath und filename sind erforderlich." }, { status: 400 });
  }
  const mimeType = typeof contentType === "string" ? contentType : undefined;

  let collection;
  try {
    const session = await requireSession();
    collection = await assertCollectionAccess(collectionId, session);

    // Der Pfad kommt vom Client. Er darf ausschliesslich in den Dateibereich
    // dieser Sammlung zeigen — sonst liesse sich fremdes Material einlesen.
    if (!blobPath.startsWith(filePathPrefix(collection.id)) || blobPath.includes("..")) {
      throw new ValidationError("Ungueltiger Dateipfad.");
    }

    assertAllowedExtension(collection, filename);
    if (collection.kind === "vector") detectKind(filename, mimeType);
  } catch (error) {
    if (error instanceof UnsupportedFileError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    await aufraeumen(() => deleteFile(blobPath));
    return errorResponse(error);
  }

  try {
    const stream = await readFile(blobPath);
    if (!stream) {
      return NextResponse.json({ error: "Die hochgeladene Datei wurde nicht gefunden." }, { status: 404 });
    }

    const buffer = await new Response(stream).arrayBuffer();
    const docId = crypto.randomUUID();
    const ergebnis = await ingest(collection, docId, buffer, filename, mimeType);

    const record: DocumentRecord = {
      id: docId,
      filename,
      size: buffer.byteLength,
      // Browser melden fuer .docx/.xlsx/.csv je nach System einen leeren Typ.
      contentType: mimeType || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
      chunkCount: ergebnis.units,
      filePath: blobPath,
      collectionId: collection.id,
    };

    try {
      await saveDocument(record);
    } catch (error) {
      // Ohne vollstaendigen Metadatensatz waere der Inhalt im Chat auffindbar,
      // in der Verwaltung aber unsichtbar und nicht mehr einzeln loeschbar.
      await aufraeumen(() => rollbackIngest(collection, docId, filename));
      await aufraeumen(() => deleteDocument(record));
      throw error;
    }

    return NextResponse.json({ document: record, replaced: ergebnis.replaced.map((r) => r.id) });
  } catch (error) {
    await aufraeumen(() => deleteFile(blobPath));
    return errorResponse(error);
  }
}

/** Aufraeumarbeiten duerfen den eigentlichen Fehler nicht verdecken. */
async function aufraeumen(schritt: () => Promise<unknown>): Promise<void> {
  try {
    await schritt();
  } catch (error) {
    console.error("Aufraeumen nach fehlgeschlagener Verarbeitung gescheitert:", error);
  }
}
