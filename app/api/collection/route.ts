import { NextResponse } from "next/server";
import { deleteAllDocuments } from "@/lib/documents";
import { MissingConfigError } from "@/lib/env";
import { resetCollection, vectorCount } from "@/lib/vector";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Kennzahlen fuer den Admin-Bereich. */
export async function GET() {
  try {
    return NextResponse.json({ vectorCount: await vectorCount() });
  } catch (error) {
    return handle(error);
  }
}

/** Leert die komplette Wissensbasis: alle Vektoren und alle Dateien. */
export async function DELETE() {
  try {
    await resetCollection();
    const removedFiles = await deleteAllDocuments();
    return NextResponse.json({ ok: true, removedFiles });
  } catch (error) {
    return handle(error);
  }
}

function handle(error: unknown): NextResponse {
  const status = error instanceof MissingConfigError ? 503 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unbekannter Fehler." },
    { status },
  );
}
