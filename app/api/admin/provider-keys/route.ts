import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { providerKeySecretKonfiguriert } from "@/lib/env";
import { ladeKeyStatus } from "@/lib/provider-keys";

export const runtime = "nodejs";

/**
 * Status je Anbieter: nur Maske und Zeitpunkt, nie der Key.
 *
 * Hinterlegen und Entfernen laufen ueber Server Actions (app/admin/actions.ts);
 * der Verbindungstest bleibt unter ./test eine eigene Route.
 */
export async function GET() {
  try {
    await requireAdmin();
    return Response.json({
      keys: await ladeKeyStatus(),
      secretKonfiguriert: providerKeySecretKonfiguriert(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
