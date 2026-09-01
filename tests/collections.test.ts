import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", async () => {
  const { fakeRedis } = await import("./helpers/fakeRedis");
  return { getRedis: () => fakeRedis };
});

// Blob: keine Sicherungen vorhanden, Schreiben und Loeschen sind No-ops.
const blob = vi.hoisted(() => ({
  put: vi.fn(async () => ({})),
  del: vi.fn(async () => undefined),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ blobs: [], hasMore: false, cursor: undefined })),
}));
vi.mock("@vercel/blob", () => blob);

const vector = vi.hoisted(() => ({
  resetNamespace: vi.fn(async () => undefined),
  resetEverything: vi.fn(async () => undefined),
}));
vi.mock("@/lib/vector", () => vector);

const sqlstore = vi.hoisted(() => ({
  deleteDatabase: vi.fn(async () => undefined),
  deleteAllDatabases: vi.fn(async () => 0),
}));
vi.mock("@/lib/sqlstore", () => sqlstore);

const graphstore = vi.hoisted(() => ({
  deleteGraph: vi.fn(async () => undefined),
  deleteAllGraphs: vi.fn(async () => 0),
}));
vi.mock("@/lib/graphstore", () => graphstore);

import { fakeRedis, hashes, keys, reset } from "./helpers/fakeRedis";
import { ADMIN_USER_ID, type Session } from "@/lib/auth";
import {
  assertCollectionAccess,
  createCollection,
  deleteCollection,
  listCollections,
  renameCollection,
} from "@/lib/collections";
import { getDocument, listDocuments, saveDocument, type DocumentRecord } from "@/lib/documents";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

const ADMIN: Session = { role: "admin", userId: ADMIN_USER_ID };
const ANNA: Session = { role: "user", userId: "anna-0000-0000" };
const BERT: Session = { role: "user", userId: "bert-0000-0000" };

beforeEach(() => {
  reset();
  vi.clearAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
  vi.stubEnv("FALKORDB_URL", "");
});

function dokument(id: string, collectionId: string): DocumentRecord {
  return {
    id,
    filename: `${id}.pdf`,
    size: 1,
    contentType: "application/pdf",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    chunkCount: 3,
    filePath: `files/${collectionId}/${id}/${id}.pdf`,
    collectionId,
  };
}

describe("Zugriff auf Sammlungen", () => {
  it("erlaubt Eigentuemer und Admin, verweigert Fremde", async () => {
    const eigene = await createCollection(ANNA.userId, "Vertraege");

    expect((await assertCollectionAccess(eigene.id, ANNA)).id).toBe(eigene.id);
    expect((await assertCollectionAccess(eigene.id, ADMIN)).id).toBe(eigene.id);
    await expect(assertCollectionAccess(eigene.id, BERT)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("meldet Unbekanntes als 404 und Unsinn als 400", async () => {
    await expect(assertCollectionAccess("gibt-es-nicht", ANNA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCollectionAccess("../etc", ANNA)).rejects.toBeInstanceOf(ValidationError);
    await expect(assertCollectionAccess(undefined, ANNA)).rejects.toBeInstanceOf(ValidationError);
  });

  it("listet nur eigene Sammlungen, der Admin alle", async () => {
    await createCollection(ANNA.userId, "A1");
    await createCollection(ANNA.userId, "A2");
    await createCollection(BERT.userId, "B1");

    expect((await listCollections(ANNA.userId)).map((c) => c.name)).toEqual(["A1", "A2"]);
    expect((await listCollections(BERT.userId)).map((c) => c.name)).toEqual(["B1"]);
    expect((await listCollections()).length).toBe(3);
  });
});

describe("Sammlungen verwalten", () => {
  it("prueft den Namen", async () => {
    await expect(createCollection(ANNA.userId, "")).rejects.toBeInstanceOf(ValidationError);
    await expect(createCollection(ANNA.userId, "x".repeat(81))).rejects.toBeInstanceOf(ValidationError);
    const c = await createCollection(ANNA.userId, "  Viel   Platz  ");
    expect(c.name).toBe("Viel Platz");
    expect(c.namespace).toBe(c.id);
  });

  it("benennt um", async () => {
    const c = await createCollection(ANNA.userId, "Alt");
    const neu = await renameCollection(c, "Neu");
    expect(neu.name).toBe("Neu");
    expect((await listCollections(ANNA.userId))[0].name).toBe("Neu");
  });

  it("loescht Sammlung samt Dokumenten, Index-Eintraegen und Namespace", async () => {
    const c = await createCollection(ANNA.userId, "Weg damit");
    await saveDocument(dokument("d1", c.id));
    await saveDocument(dokument("d2", c.id));
    expect((await listDocuments(c.id)).length).toBe(2);

    await deleteCollection(c);

    expect(await listDocuments(c.id)).toEqual([]);
    expect(await fakeRedis.hget("documents:byId", "d1")).toBeNull();
    expect(vector.resetNamespace).toHaveBeenCalledWith(c.id);
    expect(blob.del).toHaveBeenCalled();
    expect(await listCollections(ANNA.userId)).toEqual([]);
  });
});

describe("Sammlungstypen", () => {
  it("legt ohne Angabe Dokumentensammlungen an und prueft den Typ", async () => {
    expect((await createCollection(ANNA.userId, "Docs")).kind).toBe("vector");
    expect((await createCollection(ANNA.userId, "Tab", "sql")).kind).toBe("sql");
    await expect(createCollection(ANNA.userId, "X", "excel")).rejects.toBeInstanceOf(ValidationError);
  });

  it("erlaubt Graph-Sammlungen nur mit FALKORDB_URL", async () => {
    await expect(createCollection(ANNA.userId, "G", "graph")).rejects.toThrow(/FALKORDB_URL/);
    vi.stubEnv("FALKORDB_URL", "falkor://user:pw@host:6379");
    expect((await createCollection(ANNA.userId, "G", "graph")).kind).toBe("graph");
  });

  it("liest alte Sammlungen ohne Typ als Dokumentensammlung", async () => {
    await fakeRedis.hset("collections", {
      alt: JSON.stringify({ id: "alt", ownerId: ANNA.userId, name: "Alt", namespace: "alt", createdAt: "2026-01-01" }),
    });
    await fakeRedis.set("collections:migrated", "1");
    expect((await listCollections(ANNA.userId))[0].kind).toBe("vector");
  });

  it("raeumt beim Loeschen den typabhaengigen Speicher", async () => {
    vi.stubEnv("FALKORDB_URL", "falkor://user:pw@host:6379");
    const tab = await createCollection(ANNA.userId, "Tab", "sql");
    const gr = await createCollection(ANNA.userId, "Gr", "graph");

    await deleteCollection(tab);
    expect(sqlstore.deleteDatabase).toHaveBeenCalledWith(tab.id);
    expect(vector.resetNamespace).not.toHaveBeenCalled();

    await deleteCollection(gr);
    expect(graphstore.deleteGraph).toHaveBeenCalledWith(gr.id);
  });
});

describe("Dokumente je Sammlung", () => {
  it("findet ein Dokument ueber die ID und kennt seine Sammlung", async () => {
    const c = await createCollection(ANNA.userId, "Docs");
    await saveDocument(dokument("d9", c.id));
    const gefunden = await getDocument("d9");
    expect(gefunden?.collectionId).toBe(c.id);
    expect(await getDocument("d-nicht-da")).toBeNull();
  });
});

describe("Migration aus der Zeit vor den Sammlungen", () => {
  it("legt 'Standard' fuer den Admin an und uebernimmt alte Dokumente", async () => {
    // Alter Zustand: ein Hash `documents` ohne collectionId.
    const alt = { ...dokument("alt-1", ""), filePath: "files/alt-1/alt.pdf" } as Partial<DocumentRecord>;
    delete alt.collectionId;
    await fakeRedis.hset("documents", { "alt-1": JSON.stringify(alt) });

    const sammlungen = await listCollections();

    expect(sammlungen).toHaveLength(1);
    expect(sammlungen[0]).toMatchObject({ id: "standard", ownerId: ADMIN_USER_ID, name: "Standard", namespace: "" });

    const migriert = await listDocuments("standard");
    expect(migriert).toHaveLength(1);
    expect(migriert[0]).toMatchObject({ id: "alt-1", collectionId: "standard", filePath: "files/alt-1/alt.pdf" });
    expect(await fakeRedis.hget("documents:byId", "alt-1")).toBe("standard");
    expect(hashes.has("documents")).toBe(false);
    expect(keys.get("collections:migrated")).toBe("1");
  });

  it("laeuft ohne Altbestand einfach durch und merkt sich das", async () => {
    expect(await listCollections()).toEqual([]);
    expect(keys.get("collections:migrated")).toBe("1");
    expect(blob.list).toHaveBeenCalledTimes(1);

    await listCollections();
    expect(blob.list).toHaveBeenCalledTimes(1);
  });

  it("nur der Admin kommt an 'Standard'", async () => {
    await fakeRedis.hset("documents", { "alt-1": JSON.stringify(dokument("alt-1", "")) });
    await listCollections();
    await expect(assertCollectionAccess("standard", ANNA)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await assertCollectionAccess("standard", ADMIN)).namespace).toBe("");
  });
});
