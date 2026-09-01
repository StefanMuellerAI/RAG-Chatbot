import { NextResponse } from "next/server";
import { NotFoundError, errorResponse, requireSession } from "@/lib/api";
import { assertCollectionAccess } from "@/lib/collections";
import { deleteDocument, getDocument } from "@/lib/documents";
import { deleteDocumentChunks } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Entfernt ein einzelnes Dokument samt aller zugehoerigen Abschnitte. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await context.params;

    const record = await getDocument(id);
    if (!record) throw new NotFoundError("Dokument nicht gefunden.");
    const collection = await assertCollectionAccess(record.collectionId, session);

    // Erst die Abschnitte: bliebe der Metadatensatz als einziger stehen,
    // waere das Dokument sichtbar und im Chat unauffindbar. Andersherum
    // waeren die Abschnitte verwaist und ueber die Oberflaeche nicht mehr loeschbar.
    const deleted = await deleteDocumentChunks(collection.namespace, id);
    await deleteDocument(record);

    return NextResponse.json({ ok: true, deletedChunks: deleted });
  } catch (error) {
    return errorResponse(error);
  }
}
