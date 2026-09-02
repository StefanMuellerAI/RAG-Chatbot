import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladeEinladungen } from "@/lib/einladungen";

export const runtime = "nodejs";

// Nur lesend. Einladen und Widerrufen laufen ueber Server Actions
// (app/admin/actions.ts).
export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ einladungen: await ladeEinladungen() });
  } catch (error) {
    return errorResponse(error);
  }
}
