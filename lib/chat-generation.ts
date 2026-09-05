import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql, lt } from "drizzle-orm";
import { getDb } from "./db";
import { chatRuns, chats, messages, type StoredSource } from "./db/schema";
import { ownChat } from "./chat-pages";
import { ValidationError } from "./errors";
import type { ChatRequest, GenerationStatus } from "./chat-contract";
import type { ToolStep } from "./tools-types";

export function requestHash(request: ChatRequest): string {
  return createHash("sha256").update(JSON.stringify({
    chatId: request.chatId, question: request.question,
    collectionIds: [...new Set(request.collectionIds ?? [])].sort(), detail: request.detail,
  })).digest("hex");
}
export async function existingRun(userId: string, request: ChatRequest) {
  await ownChat(userId, request.chatId);
  const run = await getDb().query.chatRuns.findFirst({ where: eq(chatRuns.id, request.requestId) });
  if (!run) return null;
  if (run.userId !== userId || run.chatId !== request.chatId || run.requestHash !== requestHash(request)) {
    throw new ValidationError("Diese Anfragekennung gehoert zu einer anderen Frage.");
  }
  const answer = await getDb().query.messages.findFirst({ where: eq(messages.id, run.assistantMessageId) });
  return { run, answer };
}

/** Caller holds the per-chat Redis lease. Atomic batch keeps run and messages together. */
export async function beginGeneration(userId: string, request: ChatRequest) {
  // existingRun checks ownership even when there is no earlier attempt.
  const previous = await existingRun(userId, request);
  if (previous?.run.status === "completed") return previous.run;
  if (previous?.run.status === "streaming" && previous.run.updatedAt.getTime() > Date.now() - 300_000) {
    throw new ValidationError("Diese Antwort wird bereits erstellt.");
  }
  const db = getDb();
  const now = new Date();
  const run = previous ? { ...previous.run, attempt: previous.run.attempt + 1, status: "streaming" as const, updatedAt: now } : {
    id: request.requestId, userId, chatId: request.chatId, requestHash: requestHash(request),
    request: { question: request.question, collectionIds: request.collectionIds, detail: request.detail },
    userMessageId: randomUUID(), assistantMessageId: randomUUID(), status: "streaming" as const, attempt: 1, updatedAt: now,
  };
  const touch = db.update(chats).set({
    updatedAt: now,
    // Evaluate against the current row so a concurrent manual rename wins.
    title: sql`case when ${chats.titleManual} = false and ${chats.title} = 'Neuer Chat'
      then ${request.question.replace(/\s+/g, " ").slice(0, 60)} else ${chats.title} end`,
  }).where(and(eq(chats.id, request.chatId), eq(chats.userId, userId)));
  if (previous) {
    await db.batch([
      db.update(chatRuns).set({ status: "streaming", attempt: run.attempt, updatedAt: now }).where(eq(chatRuns.id, run.id)),
      db.update(messages).set({ content: "", sources: [], steps: [], status: "streaming", isError: false }).where(eq(messages.id, run.assistantMessageId)),
      touch,
    ]);
  } else {
    await db.batch([
      db.insert(chatRuns).values(run),
      db.insert(messages).values([
        { id: run.userMessageId, chatId: request.chatId, requestId: run.id, role: "user", content: request.question, status: "completed", createdAt: now },
        { id: run.assistantMessageId, chatId: request.chatId, requestId: run.id, role: "assistant", content: "", status: "streaming", createdAt: new Date(now.getTime() + 1) },
      ]),
      touch,
    ]);
  }
  return run;
}

export async function generationContext(userId: string, request: ChatRequest) {
  await ownChat(userId, request.chatId);
  const rows = await getDb().select({ role: messages.role, content: messages.content, requestId: messages.requestId })
    .from(messages).where(and(eq(messages.chatId, request.chatId), eq(messages.status, "completed"), eq(messages.isError, false),
      lt(messages.createdAt, sql`(select created_at from messages where chat_id = ${request.chatId}::uuid and request_id = ${request.requestId}::uuid and role = 'user')`)))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(18);
  const previous = rows.reverse().filter(row => row.requestId !== request.requestId);
  let remaining = 8000;
  const context: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of previous.reverse()) {
    if (row.content.length > remaining) break;
    remaining -= row.content.length;
    context.unshift({ role: row.role, content: row.content });
  }
  while (context[0]?.role === "assistant") context.shift();
  return [...context, { role: "user" as const, content: request.question }];
}

export async function saveGeneration(run: typeof chatRuns.$inferSelect, state: {
  content: string; sources: StoredSource[]; steps: ToolStep[]; status: GenerationStatus;
}) {
  const db = getDb();
  await db.batch([
    db.update(messages).set({ ...state, isError: state.status === "failed" || state.status === "aborted" })
      .where(and(eq(messages.id, run.assistantMessageId), eq(messages.requestId, run.id),
        sql`exists (select 1 from chat_runs where id = ${run.id}::uuid and attempt = ${run.attempt} and status = 'streaming')`)),
    db.update(chatRuns).set({ status: state.status, updatedAt: new Date() }).where(and(
      eq(chatRuns.id, run.id), eq(chatRuns.attempt, run.attempt), eq(chatRuns.status, "streaming"),
    )),
  ]);
}

export async function saveFeedback(userId: string, chatId: string, messageId: string, feedback: { helpful: boolean; reason?: string }) {
  await ownChat(userId, chatId);
  const changed = await getDb().update(messages).set({ feedback }).where(and(
    eq(messages.chatId, chatId), eq(messages.id, messageId), eq(messages.role, "assistant"), ne(messages.status, "streaming"),
  )).returning({ id: messages.id });
  if (!changed.length) throw new ValidationError("Die Antwort wurde nicht gefunden oder ist noch nicht abgeschlossen.");
}
