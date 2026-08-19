import { NextResponse } from "next/server";
import { getDocument, readFile } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * Liefert die Originaldatei aus. Die Blobs liegen privat im Store, deshalb
 * laeuft der Download bewusst ueber diese Route — sie ist von proxy.ts
 * geschuetzt, eine direkte Blob-URL waere es nicht.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const record = await getDocument(id);
    if (!record) {
      return NextResponse.json({ error: "Dokument nicht gefunden." }, { status: 404 });
    }

    const stream = await readFile(record.filePath);
    if (!stream) {
      return NextResponse.json({ error: "Datei nicht gefunden." }, { status: 404 });
    }

    return new Response(stream, {
      headers: {
        "Content-Type": record.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unbekannter Fehler." },
      { status: 500 },
    );
  }
}
