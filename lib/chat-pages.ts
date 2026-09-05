import { and, desc, eq, or, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { chats, chatRuns, messages } from "./db/schema";
import { NotFoundError, ValidationError } from "./errors";

const cursorSchema = z.object({ at: z.string().max(50).refine(v => Number.isFinite(Date.parse(v))), id: z.uuid() });
export function decodeCursor(value?: string | null) {
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
export async function chatPage(userId: string, before?: string | null, limit = 30) {
  const cursor = decodeCursor(before);
  const rows = await getDb().select({
    id: chats.id, titel: chats.title, titelManuell: chats.titleManual,
    geaendertAm: chats.updatedAt, cursorAt: sql<string>`${chats.updatedAt}::text`,
  }).from(chats).where(and(eq(chats.userId, userId), cursor ? or(
    lt(chats.updatedAt, sql`${cursor.at}::timestamptz`),
    and(eq(chats.updatedAt, sql`${cursor.at}::timestamptz`), lt(chats.id, cursor.id)),
  ) : undefined)).orderBy(desc(chats.updatedAt), desc(chats.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    chats: page.map(row => ({ id: row.id, titel: row.titel, titelManuell: row.titelManuell, geaendertAm: row.geaendertAm.toISOString() })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}
export async function messagePage(userId: string, chatId: string, before?: string | null, limit = 40) {
  const chat = await ownChat(userId, chatId);
  const cursor = decodeCursor(before);
  const rows = await getDb().select({
    message: messages, request: chatRuns.request, runUpdatedAt: chatRuns.updatedAt,
    cursorAt: sql<string>`${messages.createdAt}::text`,
  }).from(messages).leftJoin(chatRuns, eq(messages.requestId, chatRuns.id))
    .where(and(eq(messages.chatId, chatId), cursor ? or(
      lt(messages.createdAt, sql`${cursor.at}::timestamptz`),
      and(eq(messages.createdAt, sql`${cursor.at}::timestamptz`), lt(messages.id, cursor.id)),
    ) : undefined)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    chat: { id: chat.id, titel: chat.title, titelManuell: chat.titleManual, geaendertAm: chat.updatedAt.toISOString() },
    messages: page.reverse().map(({ message, request, runUpdatedAt }) => {
      const stale = message.status === "streaming" && runUpdatedAt && runUpdatedAt.getTime() < Date.now() - 300_000;
      return { ...message, status: stale ? "aborted" : message.status, fehler: message.isError || Boolean(stale), request };
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.message.id) : null,
  };
}
