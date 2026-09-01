import { NextResponse } from "next/server";
import { ValidationError, errorResponse, readJson, requireSession } from "@/lib/api";
import { chunkBlocks } from "@/lib/chunk";
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
import { UnsupportedFileError, detectKind, extractBlocks } from "@/lib/extract";
import { deleteDocumentChunks, upsertChunks } from "@/lib/vector";

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
 * Verarbeitet eine zuvor hochgeladene Datei: Text extrahieren, in Abschnitte
 * zerlegen, in den Namespace der Sammlung schreiben und den Metadatensatz ablegen.
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
  } catch (error) {
    return errorResponse(error);
  }

  try {
    detectKind(filename, mimeType);
  } catch (error) {
    if (error instanceof UnsupportedFileError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    throw error;
  }

  try {
    const stream = await readFile(blobPath);
    if (!stream) {
      return NextResponse.json({ error: "Die hochgeladene Datei wurde nicht gefunden." }, { status: 404 });
    }

    const buffer = await new Response(stream).arrayBuffer();
    const blocks = await extractBlocks(buffer, filename, mimeType);
    const chunks = chunkBlocks(blocks);

    if (chunks.length === 0) {
      // Ohne Abschnitte gibt es kein Dokument — die Datei bliebe sonst als
      // unsichtbare, aber kostenpflichtige Leiche im Store liegen.
      await aufraeumen(() => deleteFile(blobPath));
      return NextResponse.json(
        {
          error:
            `Aus "${filename}" liess sich kein Text gewinnen. ` +
            `Bei PDFs ist das meist ein Scan ohne Texterkennung — ` +
            `eine per OCR durchsuchbare Fassung waere hier noetig.`,
        },
        { status: 422 },
      );
    }

    const docId = crypto.randomUUID();
    await upsertChunks(collection.namespace, docId, filename, chunks);

    const record: DocumentRecord = {
      id: docId,
      filename,
      size: buffer.byteLength,
      // Browser melden fuer .docx/.xlsx je nach System einen leeren Typ.
      contentType: mimeType || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
      chunkCount: chunks.length,
      filePath: blobPath,
      collectionId: collection.id,
    };

    try {
      await saveDocument(record);
    } catch (error) {
      // Ohne vollstaendigen Metadatensatz waeren die Abschnitte im Chat
      // auffindbar, in der Verwaltung aber unsichtbar und nicht mehr einzeln
      // loeschbar. Index-Eintrag und Sicherung koennen halb geschrieben sein — beides weg.
      await aufraeumen(() => deleteDocumentChunks(collection.namespace, docId));
      await aufraeumen(() => deleteDocument(record));
      throw error;
    }

    return NextResponse.json({ document: record });
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
