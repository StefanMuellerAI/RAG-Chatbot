import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlungen } from "@/lib/collections";

export const runtime = "nodejs";

/**
 * Die Sammlungen des angemeldeten Nutzers.
 *
 * Anlegen laeuft ueber die Server Action in app/sammlungen/actions.ts, die
 * die Liste im selben Roundtrip neu rendert.
 */
export async function GET() {
  try {
    const kontext = await requireKontext();
    return Response.json({ sammlungen: await ladeSammlungen(kontext.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}
