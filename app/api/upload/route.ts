import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq } from "drizzle-orm";
import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import type { CollectionKind } from "@/lib/collection-kinds";
import { CSV_MAX_BYTES } from "@/lib/csv";
import { CYPHER_MAX_BYTES } from "@/lib/cypher-script";
import { getDb } from "@/lib/db";
import { collections, documents } from "@/lib/db/schema";
import { DB_ORDNER, pfadGehoertNutzer } from "@/lib/documents";
import { requireEnv } from "@/lib/env";
import { SUPPORTED_MIME_TYPES } from "@/lib/extract";

export const runtime = "nodejs";

/**
 * Zulaessige Inhaltstypen und Obergrenzen je Sammlungstyp.
 *
 * Browser melden CSV- und Cypher-Dateien uneinheitlich (oft leer oder
 * octet-stream); die verbindliche Pruefung der Endung hat die Ankuendigung
 * bereits erledigt. Fuer Dokumentensammlungen gilt weiter die angekuendigte
 * Groesse, fuer die anderen zusaetzlich die Grenze der Verarbeitung.
 */
const ERLAUBT: Record<CollectionKind, { typen: string[]; maxBytes?: number }> = {
  vector: { typen: [...SUPPORTED_MIME_TYPES] },
  sql: {
    typen: [
      "text/csv",
      "application/csv",
      "text/plain",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ],
    maxBytes: CSV_MAX_BYTES,
  },
  graph: {
    typen: ["text/plain", "application/octet-stream", "text/x-cypher"],
    maxBytes: CYPHER_MAX_BYTES,
  },
};

/**
 * Gibt ein kurzlebiges Token aus, mit dem der Browser die Datei *direkt* zu
 * Vercel Blob hochlaedt. Das umgeht das 4,5-MB-Limit fuer Request-Bodies von
 * Serverless-Funktionen, an dem ein Formular-Upload scheitern wuerde.
 *
 * Die eigentliche Arbeit dieser Route ist die Pruefung des Pfades. Der Pfad
 * kommt vom Browser, und ohne Pruefung koennte ein angemeldeter Nutzer in den
 * Ablagebereich eines anderen schreiben. Drei Bedingungen muessen gelten:
 *
 *   1. Der Pfad beginnt mit dem Praefix des Aufrufers und zeigt nicht in den
 *      Datenbankordner `_db/`, den nur der Server beschreibt.
 *   2. Zu dem Pfad existiert ein angekuendigter Metadatensatz des Aufrufers
 *      im Zustand "wartet".
 *   3. Inhaltstyp und Groesse passen zum Typ der Sammlung.
 *
 * Die zweite Bedingung ist die wichtigste: Sie bindet jeden Upload an eine
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
        // Doppelt gesichert: pfadGehoertNutzer lehnt den Ordner bereits ab.
        // Die zweite Pruefung steht hier, damit die Sperre nicht an einer
        // spaeteren Aenderung der Pfadpruefung haengt.
        if (pathname.split("/").includes(DB_ORDNER)) {
          throw new Error("Dieser Ablagepfad ist reserviert.");
        }

        const db = getDb();

        const angekuendigt = await db.query.documents.findFirst({
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

        const sammlung = await db.query.collections.findFirst({
          columns: { kind: true },
          where: and(
            eq(collections.id, angekuendigt.collectionId),
            eq(collections.userId, kontext.userId),
          ),
        });

        if (!sammlung) {
          throw new Error("Die Sammlung zu diesem Upload existiert nicht mehr.");
        }

        const erlaubt = ERLAUBT[sammlung.kind];
        const angekuendigteGroesse = angekuendigt.sizeBytes + 1024;

        return {
          allowedContentTypes: erlaubt.typen,
          maximumSizeInBytes:
            erlaubt.maxBytes === undefined
              ? angekuendigteGroesse
              : Math.min(angekuendigteGroesse, erlaubt.maxBytes),
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
