import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { erstelleEinladung, ladeEinladungen } from "@/lib/einladungen";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ einladungen: await ladeEinladungen() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Einladung anlegen und per E-Mail verschicken. */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const eingabe = await readJson<{ email?: unknown; planId?: unknown }>(request);

    // Der Sign-up-Link muss auf DIESE Instanz zeigen (Vorschau, Produktion).
    // Der Origin der Anfrage ist dafuer die verlaesslichste Quelle; eine eigene
    // Variable dafuer gibt es in der Konfiguration nicht.
    const appUrl = new URL(request.url).origin;

    const einladung = await erstelleEinladung({
      email: eingabe.email,
      planId: eingabe.planId,
      appUrl,
    });

    return Response.json({ einladung }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
