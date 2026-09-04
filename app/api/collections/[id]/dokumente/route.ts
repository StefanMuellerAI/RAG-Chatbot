import { errorResponse, readJson } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import type { CollectionKind } from "@/lib/collection-kinds";
import { ladeSammlung } from "@/lib/collections";
import { CSV_MAX_BYTES } from "@/lib/csv";
import { CYPHER_MAX_BYTES } from "@/lib/cypher-script";
import { blobPfad, ladeDokumenteDerSammlung, legeDokumentAn } from "@/lib/documents";
import { ValidationError } from "@/lib/errors";
import { UnsupportedFileError, detectKind, istMp3 } from "@/lib/extract";
import { assertAllowedExtension } from "@/lib/ingest";
import { pruefeNeuesDokument } from "@/lib/quota";
import { transkriptionBereit } from "@/lib/transcribe";

export const runtime = "nodejs";

type Kontextparameter = { params: Promise<{ id: string }> };

export async function GET(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    await ladeSammlung(kontext.userId, id);
    return Response.json({ dokumente: await ladeDokumenteDerSammlung(kontext.userId, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Kuendigt einen Upload an: prueft das Kontingent, legt den Metadatensatz an
 * und liefert den Pfad, unter dem der Browser die Datei ablegen darf.
 *
 * Warum dieser Zwischenschritt und kein direkter Upload: Der Pfad kommt sonst
 * frei gewaehlt vom Browser, und das Kontingent liesse sich erst pruefen, wenn
 * die Datei schon liegt. So entsteht der Pfad auf dem Server, das Kontingent
 * ist vorher geprueft, und die Token-Ausgabe kann verlangen, dass zu einem
 * Upload ein angekuendigter Satz gehoert.
 */
export async function POST(request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const eingabe = await readJson<{
      filename?: string;
      contentType?: string;
      sizeBytes?: number;
    }>(request);

    const dateiname = saubererDateiname(eingabe.filename);
    const groesse = Number(eingabe.sizeBytes);

    if (!Number.isFinite(groesse) || groesse <= 0) {
      throw new ValidationError("Die Dateigroesse fehlt oder ist unplausibel.");
    }

    // Die Sammlung zuerst: Welche Formate zulaessig sind, haengt von ihrem Typ ab.
    const sammlung = await ladeSammlung(kontext.userId, id);

    // Format vor dem Kontingent: eine .doc-Datei soll gar nicht erst
    // hochgeladen werden, nur um danach an der Extraktion zu scheitern.
    assertAllowedExtension(sammlung.kind, dateiname);
    if (sammlung.kind === "vector") {
      try {
        detectKind(dateiname, eingabe.contentType);
      } catch (error) {
        if (error instanceof UnsupportedFileError) {
          throw new ValidationError(error.message);
        }
        throw error;
      }

      if (istMp3(dateiname, eingabe.contentType) && !(await transkriptionBereit())) {
        throw new ValidationError(
          "MP3-Dateien brauchen das AI Gateway oder einen hinterlegten OpenAI-Key, " +
            "damit sie transkribiert werden koennen.",
        );
      }
    }

    pruefeNeuesDokument(sammlung, sammlung.sizeClass, groesse);
    pruefeTypgrenze(sammlung.kind, groesse);

    const docId = crypto.randomUUID();
    const pfad = blobPfad(kontext.userId, id, docId, dateiname);

    const dokument = await legeDokumentAn({
      id: docId,
      collectionId: id,
      userId: kontext.userId,
      filename: dateiname,
      // `||` statt `??`: ein leerer String vom Browser soll ebenfalls auf den
      // Standardwert fallen und nicht als Inhaltstyp gespeichert werden.
      contentType: eingabe.contentType || "application/octet-stream",
      blobPath: pfad,
      sizeBytes: groesse,
    });

    return Response.json({ dokument, blobPfad: pfad }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Obergrenzen der Verarbeitung je Typ — zusaetzlich zur Dateigrenze der
 * Groessenklasse. Eine 60-MB-CSV passt vielleicht in die Klasse, aber nicht
 * in den Speicher, in dem sql.js sie zu einer Tabelle macht.
 */
function pruefeTypgrenze(kind: CollectionKind, groesse: number): void {
  const grenze =
    kind === "sql" ? CSV_MAX_BYTES : kind === "graph" ? CYPHER_MAX_BYTES : undefined;

  if (grenze !== undefined && groesse > grenze) {
    throw new ValidationError(
      `Die Datei ist ${(groesse / (1024 * 1024)).toFixed(1)} MB gross; ` +
        `${kind === "sql" ? "CSV-Dateien" : "Cypher-Skripte"} duerfen hoechstens ` +
        `${grenze / (1024 * 1024)} MB haben.`,
    );
  }
}

/**
 * Entfernt Verzeichnisanteile und Zeichen, die in einem Blob-Pfad nichts zu
 * suchen haben. Ohne das koennte ein Dateiname mit Schraegstrich die
 * Pfadstruktur unterlaufen, auf der die Mandantentrennung aufsetzt.
 */
function saubererDateiname(wert: unknown): string {
  const roh = String(wert ?? "").trim();
  const ohnePfad = roh.split(/[/\\]/).pop() ?? "";
  const sauber = ohnePfad.replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 180);

  if (sauber.length < 3 || sauber.startsWith(".")) {
    throw new ValidationError("Der Dateiname ist unbrauchbar.");
  }

  return sauber;
}
