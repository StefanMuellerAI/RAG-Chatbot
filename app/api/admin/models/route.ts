import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import {
  ladeModellKatalog,
  loescheModell,
  speichereModell,
  type ModellEingabe,
} from "@/lib/admin";
import { ValidationError } from "@/lib/errors";
import { istAnbieter } from "@/lib/models";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ modelle: await ladeModellKatalog() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Anlegen oder aendern eines Katalogeintrags. */
export async function PUT(request: Request) {
  try {
    await requireAdmin();

    const eingabe = await readJson<Partial<ModellEingabe>>(request);

    if (!istAnbieter(eingabe.provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind AI Gateway, Anthropic und OpenAI.");
    }

    await speichereModell({
      id: String(eingabe.id ?? ""),
      provider: eingabe.provider,
      label: String(eingabe.label ?? ""),
      inputPerMillion: Number(eingabe.inputPerMillion),
      outputPerMillion: Number(eingabe.outputPerMillion),
      cacheReadPerMillion: Number(eingabe.cacheReadPerMillion),
      enabled: Boolean(eingabe.enabled),
      sortOrder: Number(eingabe.sortOrder ?? 0),
    });

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();

    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("Es wurde kein Modell angegeben.");

    await loescheModell(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
