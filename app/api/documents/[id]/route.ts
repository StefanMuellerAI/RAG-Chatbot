import { NextResponse } from "next/server";
import { NotFoundError, errorResponse, requireSession } from "@/lib/api";
import { assertCollectionAccess } from "@/lib/collections";
import { getDocument } from "@/lib/documents";
import { removeDocument } from "@/lib/ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Entfernt ein einzelnes Dokument samt seiner Spuren: Abschnitte im
 * Vektor-Namespace, Tabelle in der SQLite-Datei oder Statements im Graphen
 * (der dann aus den verbleibenden Skripten neu aufgebaut wird).
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await context.params;

    const record = await getDocument(id);
    if (!record) throw new NotFoundError("Dokument nicht gefunden.");
    const collection = await assertCollectionAccess(record.collectionId, session);

    const removed = await removeDocument(collection, record);
    return NextResponse.json({ ok: true, removedUnits: removed });
  } catch (error) {
    return errorResponse(error);
  }
}
