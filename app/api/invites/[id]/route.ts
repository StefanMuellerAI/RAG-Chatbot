import { NextResponse } from "next/server";
import { NotFoundError, errorResponse, requireAdmin } from "@/lib/api";
import { revokeInvite } from "@/lib/invites";

export const runtime = "nodejs";

/** Einladung widerrufen (Admin). */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    if (!(await revokeInvite(id))) throw new NotFoundError("Einladung nicht gefunden.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
