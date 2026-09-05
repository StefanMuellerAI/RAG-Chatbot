import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ladeSammlungsStatus } from "@/lib/collections";
import { collections, documents, type DocumentStatus } from "@/lib/db/schema";
import { createPostgresFixture } from "./chat-db-fixture";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

describe("Sammlungs-Verarbeitungsstatus mit PostgreSQL", () => {
  let pg: Awaited<ReturnType<typeof createPostgresFixture>>;
  beforeAll(async () => { pg = await createPostgresFixture(); }, 30_000);
  beforeEach(async () => { await pg.reset(); mocks.getDb.mockReturnValue(pg.db); });
  afterAll(async () => { await pg?.close(); });

  const createCollection = async (userId: string) => {
    const [collection] = await pg.db.insert(collections).values({ userId, name: "Test", preset: "fliesstext", sizeClassId: "test" }).returning();
    return collection;
  };
  const addDocuments = async (userId: string, collectionId: string, statuses: DocumentStatus[]) => {
    await pg.db.insert(documents).values(statuses.map(status => ({
      userId, collectionId, status, filename: "Test.txt", contentType: "text/plain",
      blobPath: `files/${userId}/${collectionId}/${crypto.randomUUID()}`, sizeBytes: 10,
    })));
  };

  it("fasst alle Dokumentzustände pro Sammlung in einer Abfrage zusammen", async () => {
    const first = await createCollection("tenant-a");
    const second = await createCollection("tenant-a");
    await addDocuments("tenant-a", first.id, ["fertig", "fertig", "wartet", "laeuft", "fehler"]);
    await addDocuments("tenant-a", second.id, ["fehler", "fehler"]);
    const select = vi.spyOn(pg.db, "select");
    try {
      expect(await ladeSammlungsStatus("tenant-a")).toEqual({
        [first.id]: { ready: 2, pending: 2, failed: 1 },
        [second.id]: { ready: 0, pending: 0, failed: 2 },
      });
      expect(select).toHaveBeenCalledOnce();
    } finally { select.mockRestore(); }
  });

  it("liest nur Dokumente des angemeldeten Mandanten", async () => {
    const own = await createCollection("tenant-a");
    const foreign = await createCollection("tenant-b");
    await addDocuments("tenant-a", own.id, ["wartet"]);
    await addDocuments("tenant-b", foreign.id, ["fertig", "fehler", "laeuft"]);
    expect(await ladeSammlungsStatus("tenant-a")).toEqual({ [own.id]: { ready: 0, pending: 1, failed: 0 } });
    expect(await ladeSammlungsStatus("tenant-b")).toEqual({ [foreign.id]: { ready: 1, pending: 1, failed: 1 } });
  });

  it("meldet für leere Sammlungen keine fiktiven fertigen Dokumente", async () => {
    await createCollection("tenant-a");
    expect(await ladeSammlungsStatus("tenant-a")).toEqual({});
    expect(await ladeSammlungsStatus("unbekannter-mandant")).toEqual({});
  });
});
