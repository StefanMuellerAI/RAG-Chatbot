import { ADMIN_USER_ID, type Session } from "./auth";
import { isCollectionKind, type CollectionKind, type CollectionSchema } from "./collection-kinds";
import {
  LEGACY_COLLECTION_ID,
  deleteAllDocumentsEverywhere,
  deleteAllDocumentsIn,
  hasLegacyDocuments,
  migrateLegacyDocuments,
} from "./documents";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { graphConfigured } from "./env";
import { deleteAllGraphs, deleteGraph } from "./graphstore";
import { getRedis } from "./redis";
import { deleteAllDatabases, deleteDatabase } from "./sqlstore";
import { resetEverything, resetNamespace } from "./vector";

export { isCollectionKind, type CollectionKind, type CollectionSchema } from "./collection-kinds";

/**
 * Sammlungen: jeder Nutzer hat beliebig viele. Je nach Typ steckt dahinter
 * ein Upstash-Namespace (vector), eine SQLite-Datei in Blob (sql) oder ein
 * FalkorDB-Graph (graph) — plus immer ein eigener Dokumenten-Hash.
 *
 *   collections  Hash  collectionId -> Collection (JSON)
 *
 * Die Sammlung "Standard" (`namespace: ""`) nimmt beim ersten Aufruf die
 * Dokumente aus der Zeit vor den Sammlungen auf und gehoert dem Admin.
 */

export type Collection = {
  id: string;
  ownerId: string;
  name: string;
  kind: CollectionKind;
  /** Upstash-Namespace; "" fuer die migrierte Standardsammlung (Default-Namespace). */
  namespace: string;
  createdAt: string;
  /** Zusammenfassung der Struktur (Tabellen bzw. Labels) — fuer Prompt und Oberflaeche. */
  schema?: CollectionSchema;
};

const COLLECTIONS_KEY = "collections";
const MIGRATION_FLAG = "collections:migrated";

export const COLLECTION_NAME_MAX = 80;

const COLLECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isCollectionId(value: unknown): value is string {
  return typeof value === "string" && COLLECTION_ID.test(value);
}

export function assertValidName(name: unknown): string {
  if (typeof name !== "string") throw new ValidationError("Bitte einen Namen angeben.");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new ValidationError("Der Name darf nicht leer sein.");
  if (trimmed.length > COLLECTION_NAME_MAX) {
    throw new ValidationError(`Der Name darf hoechstens ${COLLECTION_NAME_MAX} Zeichen lang sein.`);
  }
  return trimmed;
}

function parseCollection(value: unknown): Collection | null {
  try {
    const collection = (typeof value === "string" ? JSON.parse(value) : value) as Partial<Collection>;
    if (!collection || typeof collection.id !== "string" || typeof collection.ownerId !== "string") return null;
    return {
      ...(collection as Collection),
      // Sammlungen aus der Zeit vor den Typen sind Dokumentensammlungen.
      kind: isCollectionKind(collection.kind) ? collection.kind : "vector",
      namespace: typeof collection.namespace === "string" ? collection.namespace : collection.id,
    };
  } catch {
    return null;
  }
}

export function assertValidKind(kind: unknown): CollectionKind {
  if (kind === undefined) return "vector";
  if (!isCollectionKind(kind)) throw new ValidationError("Unbekannter Sammlungstyp.");
  if (kind === "graph" && !graphConfigured()) {
    throw new ValidationError(
      "Graph-Sammlungen sind nicht verfuegbar: FALKORDB_URL ist in dieser Installation nicht gesetzt.",
    );
  }
  return kind;
}

async function write(collection: Collection): Promise<void> {
  await getRedis().hset(COLLECTIONS_KEY, { [collection.id]: JSON.stringify(collection) });
}

/** Alle Sammlungen, oder nur die eines Eigentuemers. */
export async function listCollections(ownerId?: string): Promise<Collection[]> {
  await ensureLegacyCollection();

  const all = await getRedis().hgetall<Record<string, unknown>>(COLLECTIONS_KEY);
  if (!all) return [];

  return Object.values(all)
    .map(parseCollection)
    .filter((collection): collection is Collection => collection !== null)
    .filter((collection) => ownerId === undefined || collection.ownerId === ownerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCollection(collectionId: string): Promise<Collection | null> {
  if (!isCollectionId(collectionId)) return null;
  await ensureLegacyCollection();
  const raw = await getRedis().hget<unknown>(COLLECTIONS_KEY, collectionId);
  return raw ? parseCollection(raw) : null;
}

export async function createCollection(ownerId: string, name: unknown, kind: unknown = "vector"): Promise<Collection> {
  const id = crypto.randomUUID();
  const collection: Collection = {
    id,
    ownerId,
    name: assertValidName(name),
    kind: assertValidKind(kind),
    namespace: id,
    createdAt: new Date().toISOString(),
  };
  await write(collection);
  return collection;
}

export async function renameCollection(collection: Collection, name: unknown): Promise<Collection> {
  const next = { ...collection, name: assertValidName(name) };
  await write(next);
  return next;
}

/** Schreibt die Strukturzusammenfassung nach einem Import oder Loeschen fort. */
export async function updateCollectionSchema(
  collection: Collection,
  schema: CollectionSchema | undefined,
): Promise<Collection> {
  const next: Collection = { ...collection };
  if (schema) next.schema = schema;
  else delete next.schema;
  await write(next);
  return next;
}

/** Entfernt Sammlung, Dokumente, Dateien und den typabhaengigen Speicher. */
export async function deleteCollection(collection: Collection): Promise<void> {
  await deleteAllDocumentsIn(collection.id);
  switch (collection.kind) {
    case "vector":
      await resetNamespace(collection.namespace);
      break;
    case "sql":
      await deleteDatabase(collection.id);
      break;
    case "graph":
      await deleteGraph(collection.id);
      break;
  }
  await getRedis().hdel(COLLECTIONS_KEY, collection.id);
}

export async function deleteCollectionsOf(ownerId: string): Promise<number> {
  const eigene = await listCollections(ownerId);
  for (const collection of eigene) await deleteCollection(collection);
  return eigene.length;
}

/** Admin-Notausgang: alle Sammlungen, Dokumente, Vektoren, Datenbanken und Graphen — Nutzerkonten bleiben. */
export async function deleteEverything(): Promise<{ collections: number; files: number }> {
  const alle = await listCollections();
  const files = await deleteAllDocumentsEverywhere(alle.map((collection) => collection.id));
  await resetEverything();
  await deleteAllDatabases();
  if (graphConfigured()) await deleteAllGraphs(alle.filter((c) => c.kind === "graph").map((c) => c.id));
  await getRedis().del(COLLECTIONS_KEY);
  return { collections: alle.length, files };
}

/**
 * Liefert die Sammlung, wenn die Sitzung darauf zugreifen darf: Eigentuemer
 * oder Admin. Fremde bekommen 403, Unbekanntes 404.
 */
export async function assertCollectionAccess(collectionId: unknown, session: Session): Promise<Collection> {
  if (!isCollectionId(collectionId)) throw new ValidationError("Ungueltige Sammlungs-ID.");

  const collection = await getCollection(collectionId);
  if (!collection) throw new NotFoundError("Sammlung nicht gefunden.");

  if (session.role !== "admin" && collection.ownerId !== session.userId) {
    throw new ForbiddenError("Diese Sammlung gehoert einem anderen Nutzer.");
  }
  return collection;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Legt einmalig die Sammlung "Standard" an, wenn es Dokumente aus der Zeit
 * vor den Sammlungen gibt, und ueberfuehrt sie. Idempotent; nach dem ersten
 * Durchlauf kostet der Aufruf ein einzelnes GET.
 */
export async function ensureLegacyCollection(): Promise<void> {
  const redis = getRedis();
  if (await redis.get(MIGRATION_FLAG)) return;

  const exists = await redis.hexists(COLLECTIONS_KEY, LEGACY_COLLECTION_ID);
  if (!exists && (await hasLegacyDocuments())) {
    await write({
      id: LEGACY_COLLECTION_ID,
      ownerId: ADMIN_USER_ID,
      name: "Standard",
      kind: "vector",
      namespace: "",
      createdAt: new Date().toISOString(),
    });
    await migrateLegacyDocuments(LEGACY_COLLECTION_ID);
  }

  await redis.set(MIGRATION_FLAG, "1");
}
