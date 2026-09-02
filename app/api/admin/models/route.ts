import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladeModellKatalog } from "@/lib/admin";

export const runtime = "nodejs";

// Nur lesend. Anlegen, Aendern und Loeschen laufen ueber Server Actions
// (app/admin/actions.ts).
export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ modelle: await ladeModellKatalog() });
  } catch (error) {
    return errorResponse(error);
  }
}
