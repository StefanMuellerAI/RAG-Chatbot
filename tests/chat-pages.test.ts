import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatPage, decodeCursor, encodeCursor, messagePage, ownChat, pageSize } from "@/lib/chat-pages";
import { createPostgresFixture, TEST_CHAT_A, TEST_CHAT_B } from "./chat-db-fixture";
import { beginGeneration } from "@/lib/chat-generation";
import { chatRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
describe("Verlaufsseiten mit eingebettetem PostgreSQL", () => {
  let pg: Awaited<ReturnType<typeof createPostgresFixture>>;
  beforeAll(async () => { pg = await createPostgresFixture(); }, 30_000);
  beforeEach(async () => { await pg.reset(); mocks.getDb.mockReturnValue(pg.db); });
  afterAll(async () => { await pg?.close(); });
  const id = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
  const timestamp = (n: number) => `2026-09-05 10:00:00.12345${n === 5 ? 7 : n === 4 ? 5 : 6}+00`;

  it("prueft Mandanten auf echten Tabellen vor dem Lesen von Nachrichten", async () => {
    await pg.client.query("INSERT INTO messages (chat_id, role, content) VALUES ($1, 'assistant', 'Privater Inhalt')", [TEST_CHAT_A]);
    await expect(ownChat("tenant-a", "not-a-uuid")).rejects.toThrow("nicht gefunden");
    await expect(ownChat("tenant-b", TEST_CHAT_A)).rejects.toThrow("nicht gefunden");
    await expect(messagePage("tenant-b", TEST_CHAT_A)).rejects.toThrow("nicht gefunden");
    expect((await messagePage("tenant-b", TEST_CHAT_B)).messages).toEqual([]);
    expect((await messagePage("tenant-a", TEST_CHAT_A)).messages[0].content).toBe("Privater Inhalt");
  });

  it("blaettert Chatlisten mit Zeitgleichstand und Mikrosekunden ohne Duplikate oder Luecken", async () => {
    await pg.client.exec("TRUNCATE chats CASCADE");
    for (const n of [1, 2, 3, 4, 5]) {
      await pg.client.query("INSERT INTO chats (id, user_id, title, updated_at) VALUES ($1, $2, $3, $4::timestamptz)", [id(n), "tenant-a", `Chat ${n}`, timestamp(n)]);
    }
    await pg.client.query("INSERT INTO chats (id, user_id, title, updated_at) VALUES ($1, $2, $3, $4::timestamptz)", [id(6), "tenant-b", "Fremd", timestamp(5)]);
    const received: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await chatPage("tenant-a", cursor, 2);
      received.push(...page.chats.map(chat => chat.id));
      cursor = page.nextCursor;
      if (received.length === 2) expect(decodeCursor(cursor)?.at).toContain(".123456");
    } while (cursor);
    expect(received).toEqual([5, 3, 2, 1, 4].map(id));
    expect(new Set(received).size).toBe(5);
    expect((await chatPage("tenant-b")).chats.map(chat => chat.id)).toEqual([id(6)]);
  });

  it("blaettert Nachrichten stabil und behaelt innerhalb jeder Seite die chronologische Reihenfolge", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await pg.client.query("INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3, $4::timestamptz)", [id(n), TEST_CHAT_A, `Antwort ${n}`, timestamp(n)]);
    }
    await pg.client.query("INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3, $4::timestamptz)", [id(6), TEST_CHAT_B, "Fremde Antwort", timestamp(5)]);
    const chronological: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await messagePage("tenant-a", TEST_CHAT_A, cursor, 2);
      chronological.unshift(...page.messages.map(message => message.id));
      cursor = page.nextCursor;
      if (chronological.length === 2) expect(decodeCursor(cursor)?.at).toContain(".123456");
    } while (cursor);
    expect(chronological).toEqual([4, 1, 2, 3, 5].map(id));
    expect(new Set(chronological).size).toBe(5);
  });

  it("kennzeichnet einen verwaisten Stream als abgebrochen und behaelt laufende Streams samt Retry-Metadaten", async () => {
    const oldRequest = { chatId: TEST_CHAT_A, requestId: crypto.randomUUID(), question: "Alte Frage", detail: "compact" as const };
    const old = await beginGeneration("tenant-a", oldRequest);
    await pg.db.update(chatRuns).set({ updatedAt: new Date(Date.now() - 301_000) }).where(eq(chatRuns.id, old.id));
    const current = await beginGeneration("tenant-a", { ...oldRequest, requestId: crypto.randomUUID(), question: "Neue Frage" });
    const page = await messagePage("tenant-a", TEST_CHAT_A);
    expect(page.messages.find(message => message.id === old.assistantMessageId))
      .toMatchObject({ status: "aborted", fehler: true, request: { question: "Alte Frage", detail: "compact" } });
    expect(page.messages.find(message => message.id === current.assistantMessageId))
      .toMatchObject({ status: "streaming", fehler: false, request: { question: "Neue Frage" } });
  });
});

describe("Verlaufscursor und Seitengroesse", () => {
  it("erhaelt PostgreSQL-Mikrosekunden und UUID bei einem Cursor-Rundlauf", () => {
    const at = "2026-09-05 10:00:00.123456+00";
    const id = "11111111-1111-4111-8111-111111111111";
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ at, id });
    expect(decodeCursor()).toBeNull();
  });

  it("weist unlesbare Cursor, Zeitpunkte und IDs kontrolliert ab", () => {
    for (const cursor of [
      "not-json", encodeCursor("invalid", crypto.randomUUID()),
      encodeCursor("2026-09-05T10:00:00Z", "not-a-uuid"),
    ]) expect(() => decodeCursor(cursor)).toThrow("Verlaufscursor");
  });

  it("begrenzt Seitengroessen und verwendet nur bei fehlendem Wert den Standard", () => {
    expect(pageSize(null, 40)).toBe(40);
    expect(pageSize("1", 40)).toBe(1);
    expect(pageSize("100", 40)).toBe(100);
    for (const value of ["", "0", "101", "-1", "1.5", "NaN", "Infinity"]) {
      expect(() => pageSize(value, 40)).toThrow("Seitengroesse");
    }
  });
});
