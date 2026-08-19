import { NextResponse } from "next/server";
import { deleteDocument, getDocument } from "@/lib/documents";
import { MissingConfigError } from "@/lib/env";
import { deleteDocumentChunks } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Entfernt ein einzelnes Dokument samt aller zugehoerigen Abschnitte. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const record = await getDocument(id);
    if (!record) {
      return NextResponse.json({ error: "Dokument nicht gefunden." }, { status: 404 });
    }

    // Erst die Abschnitte: bliebe der Metadatensatz als einziger stehen,
    // waere das Dokument im Admin sichtbar und im Chat unauffindbar. Andersherum
    // waeren die Abschnitte verwaist und ueber die Oberflaeche nicht mehr loeschbar.
    const deleted = await deleteDocumentChunks(id);
    await deleteDocument(record);

    return NextResponse.json({ ok: true, deletedChunks: deleted });
  } catch (error) {
    const status = error instanceof MissingConfigError ? 503 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unbekannter Fehler." },
      { status },
    );
  }
}
