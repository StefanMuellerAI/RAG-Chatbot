import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeDokument, leseDatei } from "@/lib/documents";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Liefert die Originaldatei aus.
 *
 * Die Blobs liegen privat im Store, der Download laeuft deshalb ueber diese
 * Route. Entscheidend ist die Zugehoerigkeitspruefung in `ladeDokument`: Der
 * Proxy stellt nur fest, dass jemand angemeldet ist. Ohne die Pruefung hier
 * koennte jeder angemeldete Nutzer mit einer geratenen ID die Dokumente aller
 * anderen herunterladen.
 */
export async function GET(_request: Request, kontextparameter: { params: Promise<{ id: string }> }) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const satz = await ladeDokument(kontext.userId, id);

    const strom = await leseDatei(satz.blobPath);
    if (!strom) throw new NotFoundError("Die Datei");

    return new Response(strom, {
      headers: {
        "Content-Type": satz.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(satz.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
