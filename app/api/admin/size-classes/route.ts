import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ladeGroessenklassen } from "@/lib/admin";

export const runtime = "nodejs";

// Nur lesend. Anlegen und Aendern laufen ueber Server Actions
// (app/admin/actions.ts), die die Seite im selben Roundtrip neu rendern.
export async function GET() {
  try {
    // Jede Admin-Route prueft die Rolle selbst. Der Proxy stellt nur sicher,
    // dass ueberhaupt jemand angemeldet ist - das genuegt hier nicht.
    await requireAdmin();
    return Response.json({ groessenklassen: await ladeGroessenklassen() });
  } catch (error) {
    return errorResponse(error);
  }
}
