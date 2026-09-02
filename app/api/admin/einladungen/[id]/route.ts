import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { widerrufeEinladung } from "@/lib/einladungen";

export const runtime = "nodejs";

type Kontextparameter = { params: Promise<{ id: string }> };

/** Einladung widerrufen — der Link aus der E-Mail wird damit unbrauchbar. */
export async function DELETE(_request: Request, kontextparameter: Kontextparameter) {
  try {
    await requireAdmin();
    const { id } = await kontextparameter.params;

    await widerrufeEinladung(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
