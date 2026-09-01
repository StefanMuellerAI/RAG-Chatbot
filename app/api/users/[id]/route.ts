import { NextResponse } from "next/server";
import { NotFoundError, ValidationError, errorResponse, readJson, requireAdmin } from "@/lib/api";
import { deleteUser, setUserDisabled } from "@/lib/users";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Nutzer sperren oder entsperren (Admin). */
export async function PATCH(request: Request, context: Params) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { disabled } = await readJson<{ disabled: unknown }>(request);
    if (typeof disabled !== "boolean") throw new ValidationError("`disabled` muss true oder false sein.");

    const user = await setUserDisabled(id, disabled);
    if (!user) throw new NotFoundError("Nutzer nicht gefunden.");
    return NextResponse.json({ user });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Nutzer samt aller Sammlungen loeschen (Admin). */
export async function DELETE(_request: Request, context: Params) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    if (!(await deleteUser(id))) throw new NotFoundError("Nutzer nicht gefunden.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
