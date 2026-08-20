import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import {
  entferneDokumentSatz,
  ladeDokument,
  loescheDatei,
} from "@/lib/documents";
import { loescheDokumentChunks } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 120;

type Kontextparameter = { params: Promise<{ id: string }> };

/**
 * Entfernt ein einzelnes Dokument samt Abschnitten und Originaldatei.
 *
 * `ladeDokument` fuehrt die Nutzer-ID in der Abfrage mit — eine fremde
 * Dokument-ID fuehrt damit zu 404 und nicht zu einer Loeschung. Beim
 * Vorgaenger genuegte hier die Sitzung, weil es nur einen Nutzer gab.
 */
export async function DELETE(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const satz = await ladeDokument(kontext.userId, id);

    // Erst die Abschnitte: bliebe der Metadatensatz als einziger stehen, waere
    // das Dokument in der Uebersicht sichtbar und im Chat unauffindbar.
    // Andersherum waeren die Abschnitte verwaist und ueber die Oberflaeche nicht
    // mehr loeschbar — sie wuerden weiter in Antworten zitiert.
    await loescheDokumentChunks(satz.collectionId, satz.id, satz.chunkCount);
    await loescheDatei(satz.blobPath).catch(() => {
      // Eine fehlende Datei ist kein Grund, den Vorgang abzubrechen: das Ziel
      // ist erreicht, wenn sie am Ende nicht mehr da ist.
    });
    await entferneDokumentSatz(satz);

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
