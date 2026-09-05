import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { beginGeneration, existingRun, generationContext, requestHash, saveFeedback, saveGeneration } from "@/lib/chat-generation";
import type { ChatRequest } from "@/lib/chat-contract";
import { chatRuns, chats, messages } from "@/lib/db/schema";
import { createPostgresFixture, TEST_CHAT_A, TEST_CHAT_B } from "./chat-db-fixture";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

const request: ChatRequest = {
  chatId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  question: "Welche Regeln gelten?", detail: "compact",
};

describe("Anfrageidentitaet", () => {
  it("bindet einen Retry an Inhalt, Chat, Sammlungsauswahl und Antwortdetail", () => {
    const hash = requestHash(request);
    for (const changed of [
      { ...request, question: "Andere Frage?" },
      { ...request, chatId: crypto.randomUUID() },
      { ...request, collectionIds: [crypto.randomUUID()] },
      { ...request, detail: "detailed" as const },
    ]) expect(requestHash(changed)).not.toBe(hash);
    expect(requestHash({ ...request, requestId: crypto.randomUUID() })).toBe(hash);
  });

  it("normalisiert Reihenfolge und doppelte Sammlungskennungen", () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(requestHash({ ...request, collectionIds: [first, second, first] }))
      .toBe(requestHash({ ...request, collectionIds: [second, first] }));
    expect(requestHash({ ...request, collectionIds: [] })).toBe(requestHash(request));
  });
});

describe("Chat-Generierung mit eingebettetem PostgreSQL", () => {
  let pg: Awaited<ReturnType<typeof createPostgresFixture>>;
  beforeAll(async () => { pg = await createPostgresFixture(); }, 30_000);
  beforeEach(async () => { await pg.reset(); mocks.getDb.mockReturnValue(pg.db); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await pg?.close(); });
  const state = (content: string, status: "completed" | "streaming" | "failed" | "aborted") => ({ content, status, sources: [], steps: [] });

  it("erstellt Lauf und Nachrichtenpaar atomar und uebernimmt die Anfragekennungen", async () => {
    const run = await beginGeneration("tenant-a", request);
    const rows = await pg.db.select().from(messages).where(eq(messages.chatId, TEST_CHAT_A));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.role === "user")).toMatchObject({ id: run.userMessageId, requestId: request.requestId, status: "completed", content: request.question });
    expect(rows.find(row => row.role === "assistant")).toMatchObject({ id: run.assistantMessageId, requestId: request.requestId, status: "streaming", content: "" });
    expect(await pg.db.select().from(chatRuns)).toHaveLength(1);
    await expect(beginGeneration("tenant-a", request)).rejects.toThrow("bereits erstellt");
    expect(await pg.db.select().from(messages)).toHaveLength(2);
  });

  it("rollt bei einem fehlgeschlagenen Nachrichten-Insert auch den Lauf zurueck", async () => {
    await pg.client.exec(`CREATE FUNCTION test_reject_message() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER test_reject_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION test_reject_message();`);
    try {
      await expect(beginGeneration("tenant-a", request)).rejects.toThrow();
      expect(await pg.db.select().from(chatRuns)).toHaveLength(0);
      expect(await pg.db.select().from(messages)).toHaveLength(0);
    } finally {
      await pg.client.exec("DROP TRIGGER test_reject_message ON messages; DROP FUNCTION test_reject_message();");
    }
  });

  it("weist fremde Chats und fremde oder veraenderte Request-IDs ab", async () => {
    const run = await beginGeneration("tenant-a", request);
    await expect(existingRun("tenant-b", request)).rejects.toThrow("nicht gefunden");
    await expect(existingRun("tenant-b", { ...request, chatId: TEST_CHAT_B })).rejects.toThrow("anderen Frage");
    await expect(existingRun("tenant-a", { ...request, question: "Geaendert" })).rejects.toThrow("anderen Frage");
    await expect(beginGeneration("tenant-b", { ...request, requestId: crypto.randomUUID() })).rejects.toThrow("nicht gefunden");
    expect((await existingRun("tenant-a", request))?.run.id).toBe(run.id);
    expect(await pg.db.select().from(chatRuns)).toHaveLength(1);
  });

  it("verwendet eine fertige Anfrage erneut, ohne Lauf oder Nachrichten zu duplizieren", async () => {
    const first = await beginGeneration("tenant-a", request);
    await saveGeneration(first, state("Fertige Antwort", "completed"));
    const again = await beginGeneration("tenant-a", request);
    expect(again).toMatchObject({ id: first.id, attempt: 1, userMessageId: first.userMessageId, assistantMessageId: first.assistantMessageId, status: "completed" });
    expect((await existingRun("tenant-a", request))?.answer?.content).toBe("Fertige Antwort");
    expect(await pg.db.select().from(messages)).toHaveLength(2);
  });

  it("erhoeht bei Retry den Versuch und laesst einen alten Versuch die neue Antwort nicht ueberschreiben", async () => {
    const first = await beginGeneration("tenant-a", request);
    await saveGeneration(first, state("Teilantwort", "aborted"));
    const retry = await beginGeneration("tenant-a", request);
    expect(retry).toMatchObject({ attempt: 2, userMessageId: first.userMessageId, assistantMessageId: first.assistantMessageId });
    await saveGeneration(retry, state("Neuer Teiltext", "streaming"));
    await saveGeneration(first, state("Veraltetes Ergebnis", "completed"));
    const stored = await existingRun("tenant-a", request);
    expect(stored?.run).toMatchObject({ status: "streaming", attempt: 2 });
    expect(stored?.answer).toMatchObject({ content: "Neuer Teiltext", status: "streaming" });
    expect(await pg.db.select().from(messages)).toHaveLength(2);
  });

  it("laesst auch spaete Saves desselben Versuchs einen terminalen Zustand nicht zuruecksetzen", async () => {
    const run = await beginGeneration("tenant-a", request);
    await saveGeneration(run, state("Abgeschlossen", "completed"));
    await saveGeneration(run, state("Spaeter Zwischenstand", "streaming"));
    await saveGeneration(run, state("Spaeter Fehler", "failed"));
    const stored = await existingRun("tenant-a", request);
    expect(stored?.run.status).toBe("completed");
    expect(stored?.answer).toMatchObject({ content: "Abgeschlossen", status: "completed", isError: false });
  });

  it("kann einen verwaisten Lauf nach Ablauf der Lease erneut beginnen", async () => {
    const first = await beginGeneration("tenant-a", request);
    await pg.db.update(chatRuns).set({ updatedAt: new Date(Date.now() - 301_000) }).where(eq(chatRuns.id, first.id));
    const retry = await beginGeneration("tenant-a", request);
    expect(retry.attempt).toBe(2);
    expect(retry.assistantMessageId).toBe(first.assistantMessageId);
  });

  it("nimmt bei einem Retry nur den Verlauf vor der urspruenglichen Frage, ohne fremde und fehlerhafte Nachrichten", async () => {
    const run = await beginGeneration("tenant-a", request);
    const questionTime = new Date("2026-09-05T10:00:00Z");
    await pg.db.update(messages).set({ createdAt: questionTime }).where(eq(messages.id, run.userMessageId));
    await pg.db.insert(messages).values([
      { chatId: TEST_CHAT_A, role: "user", content: "Fruehere Frage", createdAt: new Date(questionTime.getTime() - 2000) },
      { chatId: TEST_CHAT_A, role: "assistant", content: "Fruehere Antwort", createdAt: new Date(questionTime.getTime() - 1000) },
      { chatId: TEST_CHAT_A, role: "assistant", content: "Fehler darf nicht hinein", status: "failed", isError: true, createdAt: new Date(questionTime.getTime() - 500) },
      { chatId: TEST_CHAT_A, role: "user", content: "Spaetere Frage", createdAt: new Date(questionTime.getTime() + 1000) },
      { chatId: TEST_CHAT_A, role: "assistant", content: "Spaetere Antwort", createdAt: new Date(questionTime.getTime() + 2000) },
      { chatId: TEST_CHAT_B, role: "user", content: "Fremder Mandant", createdAt: new Date(questionTime.getTime() - 1500) },
    ]);
    expect(await generationContext("tenant-a", request)).toEqual([
      { role: "user", content: "Fruehere Frage" },
      { role: "assistant", content: "Fruehere Antwort" },
      { role: "user", content: request.question },
    ]);
    await expect(generationContext("tenant-b", request)).rejects.toThrow("nicht gefunden");
  });

  it("bewahrt einen manuellen Titel, der erst nach dem Lesen des Chats gespeichert wurde", async () => {
    const batch = pg.db.batch.bind(pg.db);
    vi.spyOn(pg.db, "batch").mockImplementationOnce(async statements => {
      await pg.db.update(chats).set({ title: "Manuell gewaehlt", titleManual: true }).where(eq(chats.id, TEST_CHAT_A));
      return batch(statements);
    });
    await beginGeneration("tenant-a", request);
    expect(await pg.db.query.chats.findFirst({ where: eq(chats.id, TEST_CHAT_A) }))
      .toMatchObject({ title: "Manuell gewaehlt", titleManual: true });
  });

  it("speichert Feedback nur an einer fertigen Assistentenantwort im eigenen Chat", async () => {
    const run = await beginGeneration("tenant-a", request);
    await expect(saveFeedback("tenant-a", TEST_CHAT_A, run.assistantMessageId, { helpful: false })).rejects.toThrow();
    await saveGeneration(run, state("Antwort", "completed"));
    await expect(saveFeedback("tenant-b", TEST_CHAT_A, run.assistantMessageId, { helpful: true })).rejects.toThrow("nicht gefunden");
    await expect(saveFeedback("tenant-b", TEST_CHAT_B, run.assistantMessageId, { helpful: true })).rejects.toThrow();
    await expect(saveFeedback("tenant-a", TEST_CHAT_A, run.userMessageId, { helpful: true })).rejects.toThrow();
    await saveFeedback("tenant-a", TEST_CHAT_A, run.assistantMessageId, { helpful: true, reason: "Hilfreich" });
    expect(await pg.db.query.messages.findFirst({ where: and(eq(messages.id, run.assistantMessageId), eq(messages.chatId, TEST_CHAT_A)) }))
      .toMatchObject({ feedback: { helpful: true, reason: "Hilfreich" } });
  });
});
