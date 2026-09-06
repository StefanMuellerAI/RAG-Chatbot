import { and, desc, eq, or, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { chats, chatRuns, messages, type Chat } from "./db/schema";
import {
  sammlungenAbfrage, sammlungsStatusAbfrage, zuSammlungen, zuSammlungsStatus,
  type SammlungMitKlasse, type SammlungsStatus,
} from "./collections";
import { NotFoundError, ValidationError } from "./errors";

/**
 * Seitenweise Verlaufsdaten: Chatliste und Nachrichten mit stabilen
 * Zeit-/UUID-Cursorn. Die Abfragen sind als Builder ausgelegt, damit die
 * Chat-Seite sie in EINEM Batch mit den Sammlungen laden kann, statt nach dem
 * Seitenaufbau zwei weitere Runden zum Server zu drehen.
 */

type Cursor = { at: string; id: string };
const cursorSchema = z.object({ at: z.string().max(50).refine(v => Number.isFinite(Date.parse(v))), id: z.uuid() });
export function decodeCursor(value?: string | null): Cursor | null {
  if (!value) return null;
  try { return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { throw new ValidationError("Der Verlaufscursor ist ungueltig. Bitte neu laden."); }
}
export function encodeCursor(at: string, id: string) {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}
export function pageSize(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new ValidationError("Ungueltige Seitengroesse.");
  return value;
}
export async function ownChat(userId: string, chatId: string) {
  if (!z.uuid().safeParse(chatId).success) throw new NotFoundError("Der Chat");
  const chat = await getDb().query.chats.findFirst({ where: and(eq(chats.id, chatId), eq(chats.userId, userId)) });
  if (!chat) throw new NotFoundError("Der Chat");
  return chat;
}

const zuChatEintrag = (chat: Chat) => ({ id: chat.id, titel: chat.title, titelManuell: chat.titleManual, geaendertAm: chat.updatedAt.toISOString() });

// --- Chatliste ---------------------------------------------------------------

export function chatSeiteAbfrage(userId: string, cursor: Cursor | null, limit: number) {
  return getDb().select({
    id: chats.id, titel: chats.title, titelManuell: chats.titleManual,
    geaendertAm: chats.updatedAt, cursorAt: sql<string>`${chats.updatedAt}::text`,
  }).from(chats).where(and(eq(chats.userId, userId), cursor ? or(
    lt(chats.updatedAt, sql`${cursor.at}::timestamptz`),
    and(eq(chats.updatedAt, sql`${cursor.at}::timestamptz`), lt(chats.id, cursor.id)),
  ) : undefined)).orderBy(desc(chats.updatedAt), desc(chats.id)).limit(limit + 1);
}

export function zuChatSeite(rows: Awaited<ReturnType<typeof chatSeiteAbfrage>>, limit: number) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    chats: page.map(row => ({ id: row.id, titel: row.titel, titelManuell: row.titelManuell, geaendertAm: row.geaendertAm.toISOString() })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}

export async function chatPage(userId: string, before?: string | null, limit = 30) {
  return zuChatSeite(await chatSeiteAbfrage(userId, decodeCursor(before), limit), limit);
}

// --- Nachrichten -------------------------------------------------------------

export function nachrichtenSeiteAbfrage(chatId: string, cursor: Cursor | null, limit: number) {
  return getDb().select({
    message: messages, request: chatRuns.request, runUpdatedAt: chatRuns.updatedAt,
    cursorAt: sql<string>`${messages.createdAt}::text`,
  }).from(messages).leftJoin(chatRuns, eq(messages.requestId, chatRuns.id))
    .where(and(eq(messages.chatId, chatId), cursor ? or(
      lt(messages.createdAt, sql`${cursor.at}::timestamptz`),
      and(eq(messages.createdAt, sql`${cursor.at}::timestamptz`), lt(messages.id, cursor.id)),
    ) : undefined)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit + 1);
}

export function zuNachrichtenSeite(chat: Chat, rows: Awaited<ReturnType<typeof nachrichtenSeiteAbfrage>>, limit: number) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    chat: zuChatEintrag(chat),
    messages: page.reverse().map(({ message, request, runUpdatedAt }) => {
      // Ein Lauf, der laenger als seine Lease als laufend gilt, ist verwaist.
      const stale = message.status === "streaming" && runUpdatedAt && runUpdatedAt.getTime() < Date.now() - 300_000;
      return { ...message, status: stale ? "aborted" : message.status, fehler: message.isError || Boolean(stale), request };
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.message.id) : null,
  };
}

export async function messagePage(userId: string, chatId: string, before?: string | null, limit = 40) {
  const chat = await ownChat(userId, chatId);
  return zuNachrichtenSeite(chat, await nachrichtenSeiteAbfrage(chatId, decodeCursor(before), limit), limit);
}

// --- Chat-Seite --------------------------------------------------------------

export type ChatSeite = {
  sammlungen: SammlungMitKlasse[];
  status: Record<string, SammlungsStatus>;
  chats: ReturnType<typeof zuChatSeite>;
  /** Der per Adresse gewaehlte Chat samt Nachrichten; null, wenn keiner oder ein fremder gewaehlt ist. */
  aktiverChat: ReturnType<typeof zuNachrichtenSeite> | null;
};

/**
 * Alles fuer die Chat-Seite in einem Batch: Sammlungen, Verarbeitungsstand,
 * Chatliste und, bei einem Deep-Link, der gewaehlte Chat mit seinen
 * Nachrichten. Vorher holte der Browser Chatliste und Nachrichten erst nach
 * dem Seitenaufbau in zwei weiteren Runden.
 */
export async function ladeChatSeite(userId: string, chatId: string | null): Promise<ChatSeite> {
  const db = getDb();
  const gewaehlt = chatId && z.uuid().safeParse(chatId).success ? chatId : null;

  if (!gewaehlt) {
    const [sammlungen, status, chatZeilen] = await db.batch([
      sammlungenAbfrage(userId), sammlungsStatusAbfrage(userId), chatSeiteAbfrage(userId, null, 30),
    ]);
    return { sammlungen: zuSammlungen(sammlungen), status: zuSammlungsStatus(status), chats: zuChatSeite(chatZeilen, 30), aktiverChat: null };
  }

  const [sammlungen, status, chatZeilen, gewaehlteZeilen, nachrichtenZeilen] = await db.batch([
    sammlungenAbfrage(userId), sammlungsStatusAbfrage(userId), chatSeiteAbfrage(userId, null, 30),
    db.select().from(chats).where(and(eq(chats.id, gewaehlt), eq(chats.userId, userId))).limit(1),
    nachrichtenSeiteAbfrage(gewaehlt, null, 40),
  ]);
  const chat = gewaehlteZeilen[0];
  return {
    sammlungen: zuSammlungen(sammlungen), status: zuSammlungsStatus(status), chats: zuChatSeite(chatZeilen, 30),
    // Nachrichten eines fremden Chats verlassen den Server nicht: ohne eigene Chatzeile kein Verlauf.
    aktiverChat: chat ? zuNachrichtenSeite(chat, nachrichtenZeilen, 40) : null,
  };
}
