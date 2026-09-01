import { NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/api";
import { deleteEverything } from "@/lib/collections";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Admin-Notausgang: leert die komplette Wissensbasis — alle Sammlungen,
 * Dokumente, Dateien und Vektoren. Nutzerkonten und Einstellungen bleiben.
 */
export async function DELETE() {
  try {
    await requireAdmin();
    const result = await deleteEverything();
    return NextResponse.json({ ok: true, removedCollections: result.collections, removedFiles: result.files });
  } catch (error) {
    return errorResponse(error);
  }
}
