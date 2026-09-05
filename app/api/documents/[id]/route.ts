import { randomUUID } from "node:crypto";
import { del } from "@vercel/blob";
import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { CapacityLeaseLostError, checkIngestionCapacity, ingestionSignal, protectIngestionLock, withIngestionCapacity } from "@/lib/capacity";
import { requireEnv } from "@/lib/env";
import { ladeSammlung } from "@/lib/collections";
import {
  entferneDokumentSatz,
  ladeDokument,
  ladeDokumenteDerSammlung,
  loescheDatei,
} from "@/lib/documents";
import { NotFoundError, ValidationError } from "@/lib/errors";
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
export async function DELETE(request: Request, kontextparameter: Kontextparameter) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
  try {
    signal.throwIfAborted();
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const satz = await ladeDokument(kontext.userId, id);
    const sammlung = await ladeSammlung(kontext.userId, satz.collectionId);
    signal.throwIfAborted();

    // Erst der Speicher: bliebe der Metadatensatz als einziger stehen, waere
    // das Dokument in der Uebersicht sichtbar und im Chat unauffindbar.
    // Andersherum waeren die Abschnitte verwaist und ueber die Oberflaeche nicht
    // mehr loeschbar — sie wuerden weiter in Antworten zitiert.
    if (sammlung.kind === "sql" || sammlung.kind === "graph") {
      const kind = sammlung.kind;
      await withIngestionCapacity(async () => {
        // Dieselbe Sperre wie der Ablauf beim Einspielen. Die SQLite-Datei wird
        // als Ganzes gelesen und zurueckgeschrieben; der Graph wird geleert und
        // aus den uebrigen Skripten neu aufgebaut. In beiden Faellen wuerde ein
        // gleichzeitiger Upload das Entfernen still ueberschreiben — oder der
        // Neuaufbau den laufenden Import wegraeumen.
        const schluessel = sperrSchluessel(sammlung.id);
        const inhaber = randomUUID();
        const acquiredAt = Date.now();

        if (!(await erwirbSperre(schluessel, inhaber, SPERRE_SEKUNDEN))) {
          throw new ValidationError(
            sammlung.kind === "sql"
              ? "In dieser Sammlung wird gerade eine Tabelle geschrieben. Bitte in wenigen Sekunden erneut versuchen."
              : "In dieser Sammlung wird gerade ein Skript eingespielt. Bitte in wenigen Sekunden erneut versuchen.",
          );
        }

        let freigabe: (() => Promise<void>) | undefined;
        try {
          freigabe = protectIngestionLock(schluessel, inhaber, SPERRE_SEKUNDEN * 1000, acquiredAt);
          checkIngestionCapacity();
          // An import may have completed while this request was waiting.
          const aktuell = await ladeDokument(kontext.userId, id);
          checkIngestionCapacity();
          if (aktuell.collectionId !== sammlung.id) throw new NotFoundError("Das Dokument");
          // Die uebrigen Saetze erst innerhalb der Sperre lesen: Sonst koennte
          // ein Import, der gerade fertig wird, im Neuaufbau fehlen.
          const uebrige =
            kind === "graph"
              ? (await ladeDokumenteDerSammlung(kontext.userId, sammlung.id)).filter(
                  (dokument) => dokument.id !== aktuell.id && dokument.status === "fertig",
                )
              : [];

          checkIngestionCapacity();
          await entferneDokumentJeTyp({
            kind,
            userId: kontext.userId,
            collectionId: sammlung.id,
            satz: aktuell,
            uebrige,
          });
          checkIngestionCapacity();
          const { BLOB_READ_WRITE_TOKEN } = requireEnv("BLOB_READ_WRITE_TOKEN");
          await del(aktuell.blobPath, { token: BLOB_READ_WRITE_TOKEN, abortSignal: ingestionSignal() });
          checkIngestionCapacity();
          // Readiness and original files remain protected until metadata deletion
          // commits, so the next graph owner cannot replay this deleted script.
          await entferneDokumentSatz(aktuell);
        } finally {
          if (freigabe) await freigabe();
          else await gibSperreFrei(schluessel, inhaber);
        }
      }, { signal });
    } else {
      await entferneDokumentJeTyp({
        kind: sammlung.kind,
        userId: kontext.userId,
        collectionId: sammlung.id,
        satz,
        uebrige: [],
      });

      signal.throwIfAborted();
      await loescheDatei(satz.blobPath).catch(() => {
        // A missing original file does not prevent metadata cleanup.
      });
      signal.throwIfAborted();
      await entferneDokumentSatz(satz);
    }

    return Response.json({ ok: true });
  } catch (error) {
    if (signal.aborted) return Response.json({ error: "Die Loeschung wurde abgebrochen. Bitte erneut versuchen.", code: "abgebrochen" }, { status: request.signal.aborted ? 499 : 504 });
    if (error instanceof CapacityLeaseLostError) return Response.json({ error: "Die Verarbeitungskapazitaet wurde unterbrochen. Bitte erneut versuchen.", code: "kapazitaet" }, { status: 503, headers: { "Retry-After": "15" } });
    return errorResponse(error);
  }
}
