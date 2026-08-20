import { errorResponse, readJson } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { aktualisiereSammlung, ladeSammlung, loescheSammlung } from "@/lib/collections";
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

    const sammlung = await ladeSammlung(kontext.userId, id);
    const dokumente = await ladeDokumenteDerSammlung(kontext.userId, id);

    return Response.json({ sammlung, dokumente });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, kontextparameter: Kontextparameter) {
  try {
    const kontext = await requireKontext();
    const { id } = await kontextparameter.params;
    const eingabe = await readJson<{ name: unknown; beschreibung: unknown }>(request);

    await aktualisiereSammlung(kontext.userId, id, eingabe);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

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
