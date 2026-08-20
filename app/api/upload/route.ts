import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq } from "drizzle-orm";
import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { getDb } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { pfadGehoertNutzer } from "@/lib/documents";
import { requireEnv } from "@/lib/env";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";

export const runtime = "nodejs";

/**
 * Gibt ein kurzlebiges Token aus, mit dem der Browser die Datei *direkt* zu
 * Vercel Blob hochlaedt. Das umgeht das 4,5-MB-Limit fuer Request-Bodies von
 * Serverless-Funktionen, an dem ein Formular-Upload scheitern wuerde.
 *
 * Die eigentliche Arbeit dieser Route ist die Pruefung des Pfades. Der Pfad
 * kommt vom Browser, und ohne Pruefung koennte ein angemeldeter Nutzer in den
 * Ablagebereich eines anderen schreiben. Zwei Bedingungen muessen gelten:
 *
 *   1. Der Pfad beginnt mit dem Praefix des Aufrufers.
 *   2. Zu dem Pfad existiert ein angekuendigter Metadatensatz des Aufrufers
 *      im Zustand "wartet".
 *
 * Die zweite Bedingung ist die wichtigere: Sie bindet jeden Upload an eine
 * vorher erfolgte Kontingentpruefung. Ohne sie koennte man den Ablagebereich
 * mit beliebig vielen Dateien fuellen, ohne je eine Grenze zu beruehren.
 */
export async function POST(request: Request) {
  try {
    const kontext = await requireKontext();
    requireEnv("BLOB_READ_WRITE_TOKEN");

    const koerper = (await request.json()) as HandleUploadBody;

    const ergebnis = await handleUpload({
      body: koerper,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pfadGehoertNutzer(pathname, kontext.userId)) {
          throw new Error("Dieser Ablagepfad gehoert nicht zu Ihrem Konto.");
        }

        const angekuendigt = await getDb().query.documents.findFirst({
          where: and(
            eq(documents.blobPath, pathname),
            eq(documents.userId, kontext.userId),
            eq(documents.status, "wartet"),
          ),
        });

        if (!angekuendigt) {
          throw new Error(
            "Zu diesem Pfad liegt keine angekuendigte Datei vor. Bitte den Upload neu starten.",
          );
        }

        return {
          allowedContentTypes: [...SUPPORTED_MIME_TYPES],
          maximumSizeInBytes: angekuendigt.sizeBytes + 1024,
          // Der Pfad ist der Schluessel, unter dem der Metadatensatz die Datei
          // wiederfindet. Ein Zufallssuffix wuerde ihn unauffindbar machen.
          addRandomSuffix: false,
        };
      },
      // Kein onUploadCompleted: der Rueckruf erreicht nur oeffentlich
      // aufloesbare URLs und funktioniert lokal nicht. Die Verarbeitung stoesst
      // stattdessen der Client an.
    });

    return Response.json(ergebnis);
  } catch (error) {
    return errorResponse(error);
  }
}
