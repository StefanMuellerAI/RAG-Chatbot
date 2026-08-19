import { Index } from "@upstash/vector";
import { requireEnv } from "./env";

/**
 * Zugriff auf die Upstash-Vector-Datenbank.
 *
 * Der Index wird mit dem eingebauten Embedding-Modell "bge-m3" betrieben:
 * Upstash erzeugt die Vektoren serverseitig aus dem Rohtext. Dadurch braucht
 * die App keinen eigenen Embedding-Anbieter, und das Modell ist mehrsprachig,
 * was fuer deutschsprachige Dokumente entscheidend ist.
 */

export type ChunkMetadata = {
  docId: string;
  filename: string;
  chunkIndex: number;
  /** Der Wortlaut liegt redundant in der Metadata, damit Treffer ihn sicher mitliefern. */
  text: string;
  /** Seitenzahl bzw. Tabellenblatt, sofern das Format so etwas kennt. */
  location?: string;
};

export type Hit = {
  score: number;
  metadata: ChunkMetadata;
};

/** Erst im Request-Handler aufrufen, niemals auf Modulebene. */
function getIndex(): Index<ChunkMetadata> {
  const env = requireEnv("UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN");
  return new Index<ChunkMetadata>({
    url: env.UPSTASH_VECTOR_REST_URL,
    token: env.UPSTASH_VECTOR_REST_TOKEN,
  });
}

/**
 * Chunk-IDs sind bewusst deterministisch praefixiert (`<docId>#<n>`).
 * Dadurch laesst sich ein komplettes Dokument spaeter mit einem einzigen
 * Praefix-Delete entfernen, ohne die IDs mitzufuehren.
 */
function chunkId(docId: string, index: number): string {
  return `${docId}#${index}`;
}

const UPSERT_BATCH_SIZE = 50;

export type UpsertChunk = { text: string; location?: string };

/** Schreibt die Chunks eines Dokuments in den Index. */
export async function upsertChunks(
  docId: string,
  filename: string,
  chunks: UpsertChunk[],
): Promise<void> {
  const index = getIndex();

  for (let offset = 0; offset < chunks.length; offset += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + UPSERT_BATCH_SIZE).map((chunk, i) => ({
      id: chunkId(docId, offset + i),
      data: chunk.text,
      metadata: {
        docId,
        filename,
        chunkIndex: offset + i,
        text: chunk.text,
        ...(chunk.location ? { location: chunk.location } : {}),
      } satisfies ChunkMetadata,
    }));

    try {
      await index.upsert(batch);
    } catch (error) {
      throw new Error(explainUpstashError(error), { cause: error });
    }
  }
}

/** Sucht die relevantesten Abschnitte zu einer Frage. */
export async function search(question: string, topK = 8): Promise<Hit[]> {
  const index = getIndex();

  let results;
  try {
    results = await index.query({ data: question, topK, includeMetadata: true });
  } catch (error) {
    throw new Error(explainUpstashError(error), { cause: error });
  }

  return results
    .filter((result): result is typeof result & { metadata: ChunkMetadata } =>
      Boolean(result.metadata?.text),
    )
    .map((result) => ({ score: result.score, metadata: result.metadata }));
}

/** Entfernt alle Chunks eines einzelnen Dokuments. */
export async function deleteDocumentChunks(docId: string): Promise<number> {
  const index = getIndex();
  const { deleted } = await index.delete({ prefix: `${docId}#` });
  return deleted;
}

/** Leert die gesamte Collection inklusive aller Namespaces. */
export async function resetCollection(): Promise<void> {
  const index = getIndex();
  await index.reset({ all: true });
}

/** Anzahl gespeicherter Vektoren — fuer die Anzeige im Admin-Bereich. */
export async function vectorCount(): Promise<number> {
  const index = getIndex();
  const info = await index.info();
  return info.vectorCount;
}

/**
 * Der mit Abstand haeufigste Konfigurationsfehler ist ein Index, der ohne
 * eingebautes Embedding-Modell angelegt wurde. Upstash antwortet darauf mit
 * einer generischen Meldung — hier wird daraus ein verwertbarer Hinweis.
 */
function explainUpstashError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/embedding|data|dimension/i.test(message)) {
    return (
      `Der Upstash-Index nimmt keinen Rohtext entgegen (${message}). ` +
      `Sehr wahrscheinlich wurde er ohne eingebautes Embedding-Modell angelegt. ` +
      `Bitte in der Upstash-Konsole einen neuen Index mit dem Modell "bge-m3" erstellen ` +
      `und UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN entsprechend aktualisieren.`
    );
  }
  return `Zugriff auf die Vektor-Datenbank fehlgeschlagen: ${message}`;
}
