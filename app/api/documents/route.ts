import { NextResponse } from "next/server";
import { chunkBlocks } from "@/lib/chunk";
import {
  FILE_PREFIX,
  listDocuments,
  saveDocument,
  type DocumentRecord,
} from "@/lib/documents";
import { MissingConfigError } from "@/lib/env";
import { UnsupportedFileError, detectKind, extractBlocks } from "@/lib/extract";
import { readFile } from "@/lib/documents";
import { upsertChunks } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Liste aller eingepflegten Dokumente. */
export async function GET() {
  try {
    return NextResponse.json({ documents: await listDocuments() });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Verarbeitet eine zuvor hochgeladene Datei: Text extrahieren, in Abschnitte
 * zerlegen, in die Vektor-Datenbank schreiben und den Metadatensatz ablegen.
 */
export async function POST(request: Request) {
  const { blobPath, filename, contentType } = (await request.json().catch(() => ({}))) as {
    blobPath?: string;
    filename?: string;
    contentType?: string;
  };

  if (typeof blobPath !== "string" || typeof filename !== "string") {
    return NextResponse.json({ error: "blobPath und filename sind erforderlich." }, { status: 400 });
  }

  // Der Pfad kommt vom Client. Er darf ausschliesslich in den Dateibereich
  // zeigen, damit hierueber niemand Metadatensaetze einlesen kann.
  if (!blobPath.startsWith(FILE_PREFIX)) {
    return NextResponse.json({ error: "Ungueltiger Dateipfad." }, { status: 400 });
  }

  try {
    detectKind(filename, contentType);
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
    const blocks = await extractBlocks(buffer, filename, contentType);
    const chunks = chunkBlocks(blocks);

    if (chunks.length === 0) {
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
    await upsertChunks(docId, filename, chunks);

    const record: DocumentRecord = {
      id: docId,
      filename,
      size: buffer.byteLength,
      contentType: contentType ?? "application/octet-stream",
      uploadedAt: new Date().toISOString(),
      chunkCount: chunks.length,
      filePath: blobPath,
    };
    await saveDocument(record);

    return NextResponse.json({ document: record });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof MissingConfigError ? 503 : 500;
  const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
  return NextResponse.json({ error: message }, { status });
}
