import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";
import { MissingConfigError, requireEnv } from "@/lib/env";

export const runtime = "nodejs";

/** 100 MB — grosszuegig genug fuer umfangreiche Handbuecher. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Gibt ein kurzlebiges Token aus, mit dem der Browser die Datei *direkt* zu
 * Vercel Blob hochlaedt. Das umgeht das 4,5-MB-Limit fuer Request-Bodies von
 * Serverless-Funktionen, an dem ein normaler Formular-Upload scheitern wuerde.
 *
 * Der Zugriffsschutz liegt in proxy.ts — diese Route ist bereits gesperrt,
 * wenn sie erreicht wird.
 */
export async function POST(request: Request) {
  try {
    requireEnv("BLOB_READ_WRITE_TOKEN");
  } catch (error) {
    if (error instanceof MissingConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [...SUPPORTED_MIME_TYPES],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      }),
      // Kein onUploadCompleted: der Callback erreicht nur oeffentlich
      // aufloesbare URLs und funktioniert lokal nicht. Die Verarbeitung
      // stoesst stattdessen der Client per POST /api/documents an.
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload fehlgeschlagen." },
      { status: 400 },
    );
  }
}
