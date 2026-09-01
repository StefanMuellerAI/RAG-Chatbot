import { NextResponse } from "next/server";
import { errorResponse, readJson, requireSession } from "@/lib/api";
import { assertCollectionAccess, deleteCollection, renameCollection } from "@/lib/collections";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Sammlung umbenennen (Eigentuemer oder Admin). */
export async function PATCH(request: Request, context: Params) {
  try {
    const session = await requireSession();
    const { id } = await context.params;
    const collection = await assertCollectionAccess(id, session);

    const { name } = await readJson<{ name: unknown }>(request);
    return NextResponse.json({ collection: await renameCollection(collection, name) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Sammlung samt Dokumenten, Dateien und Vektoren loeschen (Eigentuemer oder Admin). */
export async function DELETE(_request: Request, context: Params) {
  try {
    const session = await requireSession();
    const { id } = await context.params;
    const collection = await assertCollectionAccess(id, session);

    await deleteCollection(collection);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
