import { NotFoundError, errorResponse, requireSession } from "@/lib/api";
import { assertCollectionAccess } from "@/lib/collections";
import { getDocument, readFile } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * Liefert die Originaldatei aus. Die Blobs liegen privat im Store, deshalb
 * laeuft der Download bewusst ueber diese Route — nur Eigentuemer der
 * Sammlung und der Admin kommen durch.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await context.params;

    const record = await getDocument(id);
    if (!record) throw new NotFoundError("Dokument nicht gefunden.");
    await assertCollectionAccess(record.collectionId, session);

    const stream = await readFile(record.filePath);
    if (!stream) throw new NotFoundError("Datei nicht gefunden.");

    return new Response(stream, {
      headers: {
        "Content-Type": record.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
