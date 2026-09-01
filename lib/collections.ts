import { ADMIN_USER_ID, type Session } from "./auth";
import {
  LEGACY_COLLECTION_ID,
  deleteAllDocumentsEverywhere,
  deleteAllDocumentsIn,
  hasLegacyDocuments,
  migrateLegacyDocuments,
} from "./documents";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { getRedis } from "./redis";
import { resetEverything, resetNamespace } from "./vector";

/**
 * Sammlungen: jeder Nutzer hat beliebig viele, jede ist ein eigener
 * Upstash-Namespace und ein eigener Dokumenten-Hash.
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
  /** Upstash-Namespace; "" fuer die migrierte Standardsammlung (Default-Namespace). */
  namespace: string;
  createdAt: string;
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
    const collection = (typeof value === "string" ? JSON.parse(value) : value) as Collection;
    return collection && typeof collection.id === "string" && typeof collection.ownerId === "string"
      ? { ...collection, namespace: typeof collection.namespace === "string" ? collection.namespace : collection.id }
      : null;
  } catch {
    return null;
  }
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

export async function createCollection(ownerId: string, name: unknown): Promise<Collection> {
  const id = crypto.randomUUID();
  const collection: Collection = {
    id,
    ownerId,
    name: assertValidName(name),
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

/** Entfernt Sammlung, Dokumente, Dateien und Vektoren. */
export async function deleteCollection(collection: Collection): Promise<void> {
  await deleteAllDocumentsIn(collection.id);
  await resetNamespace(collection.namespace);
  await getRedis().hdel(COLLECTIONS_KEY, collection.id);
}

export async function deleteCollectionsOf(ownerId: string): Promise<number> {
  const eigene = await listCollections(ownerId);
  for (const collection of eigene) await deleteCollection(collection);
  return eigene.length;
}

/** Admin-Notausgang: alle Sammlungen, Dokumente und Vektoren — Nutzerkonten bleiben. */
export async function deleteEverything(): Promise<{ collections: number; files: number }> {
  const alle = await listCollections();
  const files = await deleteAllDocumentsEverywhere(alle.map((collection) => collection.id));
  await resetEverything();
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
      namespace: "",
      createdAt: new Date().toISOString(),
    });
    await migrateLegacyDocuments(LEGACY_COLLECTION_ID);
  }

  await redis.set(MIGRATION_FLAG, "1");
}
