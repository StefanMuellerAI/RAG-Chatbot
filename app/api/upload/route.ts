import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/api";
import type { CollectionKind } from "@/lib/collection-kinds";
import { assertCollectionAccess } from "@/lib/collections";
import { CSV_MAX_BYTES } from "@/lib/csv";
import { CYPHER_MAX_BYTES } from "@/lib/cypher-script";
import { filePathPrefix } from "@/lib/documents";
import { MissingConfigError, requireEnv } from "@/lib/env";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";

export const runtime = "nodejs";

/** 100 MB — grosszuegig genug fuer umfangreiche Handbuecher. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Zulaessige Inhaltstypen je Sammlungstyp. Browser melden CSV- und
 * Cypher-Dateien uneinheitlich (oft leer oder octet-stream); die verbindliche
 * Pruefung der Endung uebernimmt die Verarbeitungsroute.
 */
const ALLOWED: Record<CollectionKind, { types: string[]; maxBytes: number }> = {
  vector: { types: [...SUPPORTED_MIME_TYPES], maxBytes: MAX_UPLOAD_BYTES },
  sql: {
    types: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"],
    maxBytes: CSV_MAX_BYTES,
  },
  graph: { types: ["text/plain", "application/octet-stream", "text/x-cypher"], maxBytes: CYPHER_MAX_BYTES },
};

/**
 * Gibt ein kurzlebiges Token aus, mit dem der Browser die Datei *direkt* zu
 * Vercel Blob hochlaedt. Das umgeht das 4,5-MB-Limit fuer Request-Bodies von
 * Serverless-Funktionen, an dem ein normaler Formular-Upload scheitern wuerde.
 *
 * Der Client nennt im `clientPayload` die Sammlung; der Pfad muss in deren
 * Dateibereich zeigen, und die Sitzung muss Zugriff auf die Sammlung haben.
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

  let session;
  try {
    session = await requireSession();
  } catch (error) {
    return errorResponse(error);
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const collectionId = leseSammlung(clientPayload);
        const collection = await assertCollectionAccess(collectionId, session);

        if (!pathname.startsWith(filePathPrefix(collection.id)) || pathname.includes("..")) {
          throw new Error("Ungueltiger Ablagepfad.");
        }
        const erlaubt = ALLOWED[collection.kind];
        return {
          allowedContentTypes: erlaubt.types,
          maximumSizeInBytes: erlaubt.maxBytes,
          addRandomSuffix: true,
        };
      },
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

function leseSammlung(clientPayload: string | null): unknown {
  try {
    return clientPayload ? (JSON.parse(clientPayload) as { collectionId?: unknown }).collectionId : undefined;
  } catch {
    return undefined;
  }
}
