import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlung, loescheSammlung } from "@/lib/collections";
import { ladeDokumenteDerSammlung } from "@/lib/documents";

export const runtime = "nodejs";
/** Das Abraeumen von Vektoren und Dateien einer grossen Sammlung braucht Luft. */
export const maxDuration = 300;

type Kontextparameter = { params: Promise<{ id: string }> };

/** Eine Sammlung samt ihrer Dokumente. Grundlage der Fortschrittsanzeige. */
export async function GET(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    const [sammlung, dokumente] = await Promise.all([
      ladeSammlung(kontext.userId, id),
      ladeDokumenteDerSammlung(kontext.userId, id),
    ]);

    return Response.json({ sammlung, dokumente });
  } catch (error) {
    return errorResponse(error);
  }
}

// Name und Beschreibung aendern laeuft ueber die Server Action in
// app/sammlungen/actions.ts. Das Loeschen bleibt hier: Es dauert lange und
// fuehrt danach auf die Uebersicht, ein Neu-Rendern dieser Seite braucht es nicht.
export async function DELETE(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;

    await loescheSammlung(kontext.userId, id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
