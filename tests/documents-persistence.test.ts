import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { entferneDokumentSatz, legeDokumentAn, schliesseDokumentAb, setzeDokumentStatus } from "@/lib/documents";
import { verbucheIngestion } from "@/lib/verbrauch";
import { collections, documents, usageEvents } from "@/lib/db/schema";
import { createPostgresFixture } from "./chat-db-fixture";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

describe("Atomare Dokumentzaehler mit PostgreSQL", () => {
  let pg: Awaited<ReturnType<typeof createPostgresFixture>>;
  let collectionId: string;
  beforeAll(async () => { pg = await createPostgresFixture(); }, 30_000);
  beforeEach(async () => {
    await pg.reset(); mocks.getDb.mockReturnValue(pg.db);
    await pg.client.exec("TRUNCATE usage_events");
    const [collection] = await pg.db.insert(collections).values({ userId: "tenant-a", name: "Test", preset: "fliesstext", sizeClassId: "test" }).returning();
    collectionId = collection.id;
  });
  afterAll(async () => { await pg?.close(); });

  const createDocument = () => legeDokumentAn({
    id: crypto.randomUUID(), collectionId, userId: "tenant-a", filename: "Test.txt",
    contentType: "text/plain", blobPath: `files/tenant-a/${collectionId}/${crypto.randomUUID()}`, sizeBytes: 10,
  });
  const collection = () => pg.db.query.collections.findFirst({ where: eq(collections.id, collectionId) });
  const document = (id: string) => pg.db.query.documents.findFirst({ where: eq(documents.id, id) });
  const rejectCounterUpdates = () => pg.client.exec(`
    CREATE FUNCTION test_reject_counters() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test counter failure'; END $$;
    CREATE TRIGGER test_reject_counters BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION test_reject_counters();
  `);
  const allowCounterUpdates = () => pg.client.exec("DROP TRIGGER test_reject_counters ON collections; DROP FUNCTION test_reject_counters();");

  it("liefert den angelegten Datensatz und schreibt den Sammlungszaehler atomar fort", async () => {
    const record = await createDocument();
    expect(record).toMatchObject({ collectionId, userId: "tenant-a", filename: "Test.txt", status: "wartet", pageCount: 0, chunkCount: 0 });
    expect(record.uploadedAt).toBeInstanceOf(Date);
    expect(await document(record.id)).toEqual(record);
    expect(await collection()).toMatchObject({ documentCount: 1 });
  });

  it("rollt das Anlegen bei einem Fehler am Sammlungszaehler zurueck", async () => {
    await rejectCounterUpdates();
    try {
      await expect(createDocument()).rejects.toThrow();
      expect(await pg.db.select().from(documents)).toHaveLength(0);
      expect(await collection()).toMatchObject({ documentCount: 0, pageCount: 0, chunkCount: 0 });
    } finally { await allowCounterUpdates(); }
  });

  it("zaehlt einen wiederholten Abschluss nicht doppelt und korrigiert Neuverarbeitungen per Delta", async () => {
    const record = await createDocument();
    await schliesseDokumentAb(record.id, collectionId, 5, 20);
    await schliesseDokumentAb(record.id, collectionId, 5, 20);
    expect(await collection()).toMatchObject({ documentCount: 1, pageCount: 5, chunkCount: 20 });
    await setzeDokumentStatus(record.id, "laeuft");
    await schliesseDokumentAb(record.id, collectionId, 3, 12);
    expect(await collection()).toMatchObject({ documentCount: 1, pageCount: 3, chunkCount: 12 });
    expect(await document(record.id)).toMatchObject({ status: "fertig", pageCount: 3, chunkCount: 12 });
    await schliesseDokumentAb(record.id, collectionId, 8, 30);
    expect(await collection()).toMatchObject({ pageCount: 8, chunkCount: 30 });
  });

  it("bindet den Abschluss an Dokument und Sammlung gemeinsam", async () => {
    const record = await createDocument();
    const [foreign] = await pg.db.insert(collections).values({ userId: "tenant-b", name: "Fremd", preset: "fliesstext", sizeClassId: "test" }).returning();
    await expect(schliesseDokumentAb(record.id, foreign.id, 4, 10)).rejects.toThrow("nicht gefunden");
    await expect(schliesseDokumentAb(crypto.randomUUID(), collectionId, 4, 10)).rejects.toThrow("nicht gefunden");
    expect(await document(record.id)).toMatchObject({ status: "wartet", pageCount: 0, chunkCount: 0 });
    expect(await collection()).toMatchObject({ pageCount: 0, chunkCount: 0 });
    expect(await pg.db.query.collections.findFirst({ where: eq(collections.id, foreign.id) })).toMatchObject({ pageCount: 0, chunkCount: 0 });
  });

  it("rollt den Dokumentabschluss bei einem Fehler am Sammlungszaehler zurueck", async () => {
    const record = await createDocument();
    await rejectCounterUpdates();
    try {
      await expect(schliesseDokumentAb(record.id, collectionId, 4, 10)).rejects.toThrow();
      expect(await document(record.id)).toMatchObject({ status: "wartet", pageCount: 0, chunkCount: 0 });
      expect(await collection()).toMatchObject({ pageCount: 0, chunkCount: 0 });
    } finally { await allowCounterUpdates(); }
  });

  it("erhaelt alle Deltas bei gleichzeitig gestarteten Abschluessen derselben Sammlung", async () => {
    const records = await Promise.all(Array.from({ length: 10 }, createDocument));
    const finish = () => Promise.all(records.map((record, index) => schliesseDokumentAb(record.id, collectionId, index + 1, 2 * (index + 1))));
    await finish();
    await finish();
    expect(await collection()).toMatchObject({ documentCount: 10, pageCount: 55, chunkCount: 110 });
    await Promise.all([schliesseDokumentAb(records[0].id, collectionId, 4, 7), schliesseDokumentAb(records[0].id, collectionId, 8, 11)]);
    const current = await document(records[0].id);
    expect(await collection()).toMatchObject({ pageCount: 54 + current!.pageCount, chunkCount: 108 + current!.chunkCount });
  });

  it("zieht beim Loeschen aktuelle Werte ab und beruehrt bei Wiederholung keine anderen Dokumente", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await schliesseDokumentAb(first.id, collectionId, 5, 20);
    await schliesseDokumentAb(second.id, collectionId, 3, 12);
    // The snapshot still has zero counts: deletion must use DELETE RETURNING.
    await Promise.all([entferneDokumentSatz(first), entferneDokumentSatz(first)]);
    expect(await document(first.id)).toBeUndefined();
    expect(await collection()).toMatchObject({ documentCount: 1, pageCount: 3, chunkCount: 12 });
    expect(await document(second.id)).toMatchObject({ pageCount: 3, chunkCount: 12 });
  });

  it("loescht bei falschem Nutzer oder falscher Sammlung nichts", async () => {
    const record = await createDocument();
    await schliesseDokumentAb(record.id, collectionId, 3, 12);
    await entferneDokumentSatz({ ...record, collectionId: crypto.randomUUID() });
    await entferneDokumentSatz({ ...record, userId: "tenant-b" });
    expect(await document(record.id)).toBeDefined();
    expect(await collection()).toMatchObject({ documentCount: 1, pageCount: 3, chunkCount: 12 });
  });

  it("rollt bei einem Zaehlerfehler auch das DELETE zurueck", async () => {
    const record = await createDocument();
    await schliesseDokumentAb(record.id, collectionId, 3, 12);
    await rejectCounterUpdates();
    try {
      await expect(entferneDokumentSatz(record)).rejects.toThrow();
      expect(await document(record.id)).toMatchObject({ pageCount: 3, chunkCount: 12 });
      expect(await collection()).toMatchObject({ documentCount: 1, pageCount: 3, chunkCount: 12 });
    } finally { await allowCounterUpdates(); }
  });

  it("bewahrt konsistente Zaehler bei gleichzeitigem Abschluss und Loeschen", async () => {
    const record = await createDocument();
    await Promise.allSettled([schliesseDokumentAb(record.id, collectionId, 4, 10), entferneDokumentSatz(record)]);
    expect(await document(record.id)).toBeUndefined();
    expect(await collection()).toMatchObject({ documentCount: 0, pageCount: 0, chunkCount: 0 });
  });

  it("weist ungueltige Zaehler vor jeder Aenderung ab", async () => {
    const record = await createDocument();
    for (const value of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
      await expect(schliesseDokumentAb(record.id, collectionId, value, 1)).rejects.toThrow("ganze Zahlen");
    }
    expect(await document(record.id)).toMatchObject({ status: "wartet", pageCount: 0 });
    expect(await collection()).toMatchObject({ pageCount: 0, chunkCount: 0 });
  });

  it("verbucht denselben Workflow-Schritt nur einmal, neue Schritte und Mandanten jedoch getrennt", async () => {
    await Promise.all(Array.from({ length: 5 }, () => verbucheIngestion("tenant-a", 12, "step-stable")));
    const first = await pg.db.select().from(usageEvents);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "ingestion", inputTokens: 12, userId: "tenant-a" });
    expect(first[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await verbucheIngestion("tenant-a", 14, "step-new-run");
    await verbucheIngestion("tenant-b", 12, "step-stable");
    expect(await pg.db.select().from(usageEvents)).toHaveLength(3);
  });
});
