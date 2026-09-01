import { NextResponse } from "next/server";
import { errorResponse, readJson, requireSession } from "@/lib/api";
import { createCollection, listCollections } from "@/lib/collections";
import { listDocuments } from "@/lib/documents";

export const runtime = "nodejs";

/**
 * Sammlungen der Sitzung. Der Admin bekommt mit `?alle=1` saemtliche
 * Sammlungen inklusive Kennzahlen fuer die Uebersicht.
 */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const alle = session.role === "admin" && new URL(request.url).searchParams.get("alle") === "1";
    const collections = await listCollections(alle ? undefined : session.userId);

    if (!alle) return NextResponse.json({ collections });

    const mitKennzahlen = await Promise.all(
      collections.map(async (collection) => {
        const documents = await listDocuments(collection.id);
        return {
          ...collection,
          documentCount: documents.length,
          chunkCount: documents.reduce((summe, document) => summe + document.chunkCount, 0),
        };
      }),
    );
    return NextResponse.json({ collections: mitKennzahlen });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Neue Sammlung fuer die angemeldete Sitzung; `kind` ist vector (Standard), sql oder graph. */
export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const { name, kind } = await readJson<{ name: unknown; kind: unknown }>(request);
    const collection = await createCollection(session.userId, name, kind ?? "vector");
    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
