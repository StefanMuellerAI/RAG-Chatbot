import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladeNutzer, setzeAdminRolle, setzeNutzerPlan } from "@/lib/admin";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAdmin();

    const parameter = new URL(request.url).searchParams;
    const suche = parameter.get("suche") ?? "";
    const seite = Number(parameter.get("seite") ?? "1");

    return Response.json(
      await ladeNutzer(suche, Number.isFinite(seite) ? seite : 1),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Plan zuweisen oder Adminrolle setzen. */
export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();

    const eingabe = await readJson<{
      clerkUserId?: string;
      planId?: string;
      isAdmin?: boolean;
    }>(request);

    if (typeof eingabe.clerkUserId !== "string" || !eingabe.clerkUserId) {
      throw new ValidationError("Es wurde kein Nutzer angegeben.");
    }

    if (typeof eingabe.planId === "string") {
      await setzeNutzerPlan(eingabe.clerkUserId, eingabe.planId);
    }

    if (typeof eingabe.isAdmin === "boolean") {
      await setzeAdminRolle(eingabe.clerkUserId, eingabe.isAdmin, admin.userId);
    }

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
