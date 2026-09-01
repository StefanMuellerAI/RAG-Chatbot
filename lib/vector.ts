import { Index } from "@upstash/vector";
import { requireEnv } from "./env";

/**
 * Zugriff auf die Upstash-Vector-Datenbank.
 *
 * Der Index wird mit dem eingebauten Embedding-Modell "bge-m3" betrieben:
 * Upstash erzeugt die Vektoren serverseitig aus dem Rohtext. Dadurch braucht
 * die App keinen eigenen Embedding-Anbieter, und das Modell ist mehrsprachig,
 * was fuer deutschsprachige Dokumente entscheidend ist.
 *
 * Jede Sammlung lebt in einem eigenen Namespace. Der leere Namespace ("")
 * ist der Default-Namespace von Upstash — dort liegen die Vektoren aus der
 * Zeit vor den Sammlungen (heute die Sammlung "Standard").
 */

export type ChunkMetadata = {
  docId: string;
  filename: string;
  chunkIndex: number;
  /** Seitenzahl bzw. Tabellenblatt, sofern das Format so etwas kennt. */
  location?: string;
};

export type Hit = {
  score: number;
  /** Der Wortlaut des Abschnitts — kommt aus dem `data`-Feld des Vektors. */
  text: string;
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

/** Leerer Namespace = Default-Namespace; dann keine Option mitgeben. */
function nsOptions(namespace: string): { namespace: string } | undefined {
  return namespace ? { namespace } : undefined;
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
/** Wie viele Batches gleichzeitig unterwegs sind — das Embedding passiert serverseitig. */
const UPSERT_CONCURRENCY = 3;

export type UpsertChunk = { text: string; location?: string };

type UpsertItem = { id: string; data: string; metadata: ChunkMetadata };

/** Schreibt die Chunks eines Dokuments in den Namespace der Sammlung. */
export async function upsertChunks(
  namespace: string,
  docId: string,
  filename: string,
  chunks: UpsertChunk[],
): Promise<void> {
  const index = getIndex();

  const batches: UpsertItem[][] = [];
  for (let offset = 0; offset < chunks.length; offset += UPSERT_BATCH_SIZE) {
    batches.push(
      chunks.slice(offset, offset + UPSERT_BATCH_SIZE).map((chunk, i) => ({
        id: chunkId(docId, offset + i),
        data: chunk.text,
        metadata: {
          docId,
          filename,
          chunkIndex: offset + i,
          ...(chunk.location ? { location: chunk.location } : {}),
        } satisfies ChunkMetadata,
      })),
    );
  }

  for (let i = 0; i < batches.length; i += UPSERT_CONCURRENCY) {
    try {
      await Promise.all(
        batches
          .slice(i, i + UPSERT_CONCURRENCY)
          .map((batch) => index.upsert(batch, nsOptions(namespace))),
      );
    } catch (error) {
      throw new Error(explainUpstashError(error), { cause: error });
    }
  }
}

/** Sucht die relevantesten Abschnitte zu einer Frage innerhalb einer Sammlung. */
export async function search(namespace: string, question: string, topK = 8): Promise<Hit[]> {
  const index = getIndex();

  let results;
  try {
    results = await index.query(
      { data: question, topK, includeMetadata: true, includeData: true },
      nsOptions(namespace),
    );
  } catch (error) {
    throw new Error(explainUpstashError(error), { cause: error });
  }

  const hits: Hit[] = [];
  for (const result of results) {
    // Aeltere Vektoren tragen den Text zusaetzlich in der Metadata; `data` ist
    // bei beiden Generationen gesetzt und deshalb die verlaessliche Quelle.
    const text = result.data ?? (result.metadata as { text?: string } | undefined)?.text;
    if (!text || !result.metadata) continue;
    hits.push({ score: result.score, text, metadata: result.metadata });
  }
  return hits;
}

/** Entfernt alle Chunks eines einzelnen Dokuments. */
export async function deleteDocumentChunks(namespace: string, docId: string): Promise<number> {
  const index = getIndex();
  const { deleted } = await index.delete({ prefix: `${docId}#` }, nsOptions(namespace));
  return deleted;
}

/** Leert den Namespace einer Sammlung. */
export async function resetNamespace(namespace: string): Promise<void> {
  const index = getIndex();
  if (namespace) await index.reset({ namespace });
  else await index.reset();
}

/** Leert den gesamten Index inklusive aller Namespaces — der Admin-Notausgang. */
export async function resetEverything(): Promise<void> {
  const index = getIndex();
  await index.reset({ all: true });
}

/** Anzahl gespeicherter Vektoren ueber alle Namespaces — fuer die Anzeige im Admin-Bereich. */
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

  if (/embedding|dimension/i.test(message)) {
    return (
      `Der Upstash-Index nimmt keinen Rohtext entgegen (${message}). ` +
      `Sehr wahrscheinlich wurde er ohne eingebautes Embedding-Modell angelegt. ` +
      `Bitte in der Upstash-Konsole einen neuen Index mit dem Modell "bge-m3" erstellen ` +
      `und UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN entsprechend aktualisieren.`
    );
  }
  return `Zugriff auf die Vektor-Datenbank fehlgeschlagen: ${message}`;
}
