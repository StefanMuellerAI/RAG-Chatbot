import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladeNutzer } from "@/lib/admin";

export const runtime = "nodejs";

// Nur lesend. Plan zuweisen und Adminrolle setzen laufen ueber Server Actions
// (app/admin/actions.ts).
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
