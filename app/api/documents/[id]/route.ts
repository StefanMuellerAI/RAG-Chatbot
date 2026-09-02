import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlung } from "@/lib/collections";
import {
  entferneDokumentSatz,
  ladeDokument,
  ladeDokumenteDerSammlung,
  loescheDatei,
} from "@/lib/documents";
import { ValidationError } from "@/lib/errors";
import { entferneDokumentJeTyp } from "@/lib/ingest";
import { erwirbSperre, gibSperreFrei, sperrSchluessel } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

type Kontextparameter = { params: Promise<{ id: string }> };

/** So lange darf das Entfernen einer Tabelle oder eines Skripts die Sammlung hoechstens sperren. */
const SPERRE_SEKUNDEN = 120;

/**
 * Entfernt ein einzelnes Dokument samt seinen Spuren im Speicher und der
 * Originaldatei.
 *
 * `ladeDokument` fuehrt die Nutzer-ID in der Abfrage mit — eine fremde
 * Dokument-ID fuehrt damit zu 404 und nicht zu einer Loeschung. Beim
 * Vorgaenger genuegte hier die Sitzung, weil es nur einen Nutzer gab.
 *
 * Was "Spuren im Speicher" heisst, haengt vom Sammlungstyp ab: Abschnitte in
 * Pinecone, eine Tabelle in der SQLite-Datei oder Statements im Graphen, der
 * dafuer aus den uebrigen Skripten neu aufgebaut wird (lib/ingest.ts).
 */
export async function DELETE(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const satz = await ladeDokument(kontext.userId, id);
    const sammlung = await ladeSammlung(kontext.userId, satz.collectionId);

    // Erst der Speicher: bliebe der Metadatensatz als einziger stehen, waere
    // das Dokument in der Uebersicht sichtbar und im Chat unauffindbar.
    // Andersherum waeren die Abschnitte verwaist und ueber die Oberflaeche nicht
    // mehr loeschbar — sie wuerden weiter in Antworten zitiert.
    if (sammlung.kind === "sql" || sammlung.kind === "graph") {
      // Dieselbe Sperre wie der Ablauf beim Einspielen. Die SQLite-Datei wird
      // als Ganzes gelesen und zurueckgeschrieben; der Graph wird geleert und
      // aus den uebrigen Skripten neu aufgebaut. In beiden Faellen wuerde ein
      // gleichzeitiger Upload das Entfernen still ueberschreiben — oder der
      // Neuaufbau den laufenden Import wegraeumen.
      const schluessel = sperrSchluessel(sammlung.id);
      const inhaber = `loeschen:${satz.id}`;

      if (!(await erwirbSperre(schluessel, inhaber, SPERRE_SEKUNDEN))) {
        throw new ValidationError(
          sammlung.kind === "sql"
            ? "In dieser Sammlung wird gerade eine Tabelle geschrieben. Bitte in wenigen Sekunden erneut versuchen."
            : "In dieser Sammlung wird gerade ein Skript eingespielt. Bitte in wenigen Sekunden erneut versuchen.",
        );
      }

      try {
        // Die uebrigen Saetze erst innerhalb der Sperre lesen: Sonst koennte
        // ein Import, der gerade fertig wird, im Neuaufbau fehlen.
        const uebrige =
          sammlung.kind === "graph"
            ? (await ladeDokumenteDerSammlung(kontext.userId, sammlung.id)).filter(
                (dokument) => dokument.id !== satz.id && dokument.status === "fertig",
              )
            : [];

        await entferneDokumentJeTyp({
          kind: sammlung.kind,
          userId: kontext.userId,
          collectionId: sammlung.id,
          satz,
          uebrige,
        });
      } finally {
        await gibSperreFrei(schluessel, inhaber);
      }
    } else {
      await entferneDokumentJeTyp({
        kind: sammlung.kind,
        userId: kontext.userId,
        collectionId: sammlung.id,
        satz,
        uebrige: [],
      });
    }

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
