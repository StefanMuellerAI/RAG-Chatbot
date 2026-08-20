import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladePlaene, loeschePlan, speicherePlan, type PlanEingabe } from "@/lib/admin";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ plaene: await ladePlaene() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Anlegen oder aendern eines Plans. */
export async function PUT(request: Request) {
  try {
    await requireAdmin();

    const eingabe = await readJson<Partial<PlanEingabe>>(request);

    if (typeof eingabe.id !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(eingabe.id)) {
      throw new ValidationError(
        "Die Kennung muss aus 1 bis 16 Buchstaben, Ziffern, Binde- oder Unterstrichen bestehen.",
      );
    }

    await speicherePlan({
      id: eingabe.id,
      label: String(eingabe.label ?? ""),
      maxSizeClassId: String(eingabe.maxSizeClassId ?? ""),
      maxCollections: Number(eingabe.maxCollections),
      maxQuestionsPerDay: Number(eingabe.maxQuestionsPerDay),
      modelId: String(eingabe.modelId ?? ""),
      isDefault: Boolean(eingabe.isDefault),
    });

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();

    const planId = new URL(request.url).searchParams.get("id");
    if (!planId) throw new ValidationError("Es wurde kein Plan angegeben.");

    await loeschePlan(planId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
