import { start } from "workflow/api";
import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeDokument, setzeDokumentStatus } from "@/lib/documents";
import { ValidationError } from "@/lib/errors";
import { verarbeiteDokument } from "@/workflows/ingest";

export const runtime = "nodejs";

/**
 * Stoesst die Verarbeitung eines hochgeladenen Dokuments an.
 *
 * Die Route wartet nicht auf das Ergebnis: `start` legt den Ablauf an und kommt
 * sofort zurueck. Die Oberflaeche verfolgt den Fortschritt danach ueber
 * documents.status. Ein 100-seitiges PDF braucht mehr Zeit, als ein Browser
 * sinnvoll auf eine Antwort warten kann.
 */
export async function POST(
  _request: Request,
  kontextparameter: { params: Promise<{ id: string }> },
) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    // Wirft, wenn das Dokument nicht dem Aufrufer gehoert.
    const satz = await ladeDokument(kontext.userId, id);

    if (satz.status === "laeuft") {
      throw new ValidationError("Dieses Dokument wird gerade verarbeitet.");
    }

    if (satz.status === "fertig") {
      throw new ValidationError("Dieses Dokument ist bereits verarbeitet.");
    }

    const lauf = await start(verarbeiteDokument, [id]);
    await setzeDokumentStatus(id, "laeuft", { workflowRunId: lauf.runId });

    return Response.json({ ok: true, runId: lauf.runId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
