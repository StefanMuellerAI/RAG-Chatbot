import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql, lt } from "drizzle-orm";
import { getDb } from "./db";
import { chatRuns, chats, messages, type StoredSource } from "./db/schema";
import { ownChat } from "./chat-pages";
import { sammlungenAbfrage, zuSammlungen, type SammlungMitKlasse } from "./collections";
import { NotFoundError, ValidationError } from "./errors";
import type { ChatRequest, GenerationStatus } from "./chat-contract";
import type { ToolStep } from "./tools-types";

/**
 * Serverseitige Chat-Generierungen: ein Lauf je Anfragekennung mit genau einem
 * Nachrichtenpaar. Diese Datei kennt den Frageweg in drei Schritten:
 *
 *   1. `ladeVorlauf`      — alles Lesen in EINEM Batch (ein HTTP-Roundtrip beim
 *                           Neon-Treiber): Chatzugehoerigkeit, frueherer Lauf
 *                           samt Antwort, Verlauf, Sammlungen.
 *   2. `planeGeneration`  — rein, ohne Netz: entscheidet, ob ein neuer Lauf
 *                           entsteht oder ein Versuch wiederholt wird.
 *   3. `schreibeGeneration` — ein Batch fuer Lauf, Nachrichten und Chat.
 *
 * Vorher las die Route den Lauf zweimal und den Verlauf getrennt; jeder dieser
 * Aufrufe kostete die volle Latenz zur Datenbank.
 */

export type ChatRun = typeof chatRuns.$inferSelect;
type Nachricht = typeof messages.$inferSelect;
export type FruehererLauf = { run: ChatRun; answer: Nachricht | null };
export type Vorlauf = {
  previous: FruehererLauf | null;
  history: { role: "user" | "assistant"; content: string }[];
  sammlungen: SammlungMitKlasse[];
};

/** Bindet eine Anfragekennung an Chat, Frage, Sammlungsauswahl und Antwortlaenge. */
export function requestHash(request: ChatRequest): string {
  return createHash("sha256").update(JSON.stringify({
    chatId: request.chatId, question: request.question,
    collectionIds: [...new Set(request.collectionIds ?? [])].sort(), detail: request.detail,
  })).digest("hex");
}

function pruefeLauf(userId: string, request: ChatRequest, run: ChatRun): void {
  if (run.userId !== userId || run.chatId !== request.chatId || run.requestHash !== requestHash(request)) {
    throw new ValidationError("Diese Anfragekennung gehoert zu einer anderen Frage.");
  }
}

/**
 * Verlauf vor der Frage: hoechstens 18 abgeschlossene Nachrichten bzw. 8.000
 * Zeichen. Bei einer Wiederholung endet er an der urspruenglichen Frage; beim
 * ersten Versuch gibt es diese Nachricht noch nicht, dann zaehlt alles bis jetzt.
 */
function kontextAbfrage(request: ChatRequest) {
  return getDb().select({ role: messages.role, content: messages.content, requestId: messages.requestId })
    .from(messages).where(and(eq(messages.chatId, request.chatId), eq(messages.status, "completed"), eq(messages.isError, false),
      lt(messages.createdAt, sql`coalesce((select created_at from messages where chat_id = ${request.chatId}::uuid and request_id = ${request.requestId}::uuid and role = 'user'), 'infinity'::timestamptz)`)))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(18);
}

function zuKontext(
  rows: { role: "user" | "assistant"; content: string; requestId: string | null }[],
  request: ChatRequest,
): Vorlauf["history"] {
  const previous = [...rows].reverse().filter(row => row.requestId !== request.requestId);
  let remaining = 8000;
  const context: Vorlauf["history"] = [];
  for (const row of previous.reverse()) {
    if (row.content.length > remaining) break;
    remaining -= row.content.length;
    context.unshift({ role: row.role, content: row.content });
  }
  while (context[0]?.role === "assistant") context.shift();
  return [...context, { role: "user" as const, content: request.question }];
}

/** Alles, was der Frageweg vor dem ersten Schreiben wissen muss, in einem Batch. */
export async function ladeVorlauf(userId: string, request: ChatRequest): Promise<Vorlauf> {
  const db = getDb();
  const [chatZeilen, laufZeilen, antwortZeilen, kontextZeilen, sammlungsZeilen] = await db.batch([
    db.select({ id: chats.id }).from(chats).where(and(eq(chats.id, request.chatId), eq(chats.userId, userId))).limit(1),
    db.select().from(chatRuns).where(eq(chatRuns.id, request.requestId)).limit(1),
    db.select().from(messages).where(and(eq(messages.requestId, request.requestId), eq(messages.role, "assistant"))).limit(1),
    kontextAbfrage(request),
    sammlungenAbfrage(userId),
  ]);
  if (chatZeilen.length === 0) throw new NotFoundError("Der Chat");

  let previous: FruehererLauf | null = null;
  const run = laufZeilen[0];
  if (run) {
    pruefeLauf(userId, request, run);
    previous = { run, answer: antwortZeilen.find(zeile => zeile.id === run.assistantMessageId) ?? null };
  }
  return { previous, history: zuKontext(kontextZeilen, request), sammlungen: zuSammlungen(sammlungsZeilen) };
}

export async function existingRun(userId: string, request: ChatRequest): Promise<FruehererLauf | null> {
  await ownChat(userId, request.chatId);
  const run = await getDb().query.chatRuns.findFirst({ where: eq(chatRuns.id, request.requestId) });
  if (!run) return null;
  pruefeLauf(userId, request, run);
  const answer = await getDb().query.messages.findFirst({ where: eq(messages.id, run.assistantMessageId) });
  return { run, answer: answer ?? null };
}

/**
 * Entscheidet ohne Netz, was geschrieben wird. Ein abgeschlossener Lauf kommt
 * unveraendert zurueck, damit der Aufrufer ihn wiedergeben kann; ein noch
 * laufender Versuch innerhalb seiner Lease wird nicht ueberschrieben.
 */
export function planeGeneration(
  userId: string,
  request: ChatRequest,
  previous: FruehererLauf | null,
): { run: ChatRun; neu: boolean } {
  if (previous?.run.status === "completed") return { run: previous.run, neu: false };
  if (previous?.run.status === "streaming" && previous.run.updatedAt.getTime() > Date.now() - 300_000) {
    throw new ValidationError("Diese Antwort wird bereits erstellt.");
  }
  const now = new Date();
  const run: ChatRun = previous
    ? { ...previous.run, attempt: previous.run.attempt + 1, status: "streaming", updatedAt: now }
    : {
      id: request.requestId, userId, chatId: request.chatId, requestHash: requestHash(request),
      request: { question: request.question, collectionIds: request.collectionIds, detail: request.detail },
      userMessageId: randomUUID(), assistantMessageId: randomUUID(), status: "streaming", attempt: 1, updatedAt: now,
    };
  return { run, neu: !previous };
}

/**
 * Schreibt Lauf, Nachrichten und Chat in einem atomaren Batch. Der Aufrufer
 * haelt die Chat-Sperre in Redis.
 *
 * Liefert false, wenn der Lauf inzwischen von einem anderen Versuch
 * abgeschlossen oder uebernommen wurde: Der Insert trifft auf eine vorhandene
 * Zeile, das Update auf einen anderen Stand. Dann hat der Aufrufer nichts
 * geschrieben und liest den Lauf erneut, statt eine fertige Antwort zu
 * ueberschreiben.
 */
export async function schreibeGeneration(
  userId: string,
  request: ChatRequest,
  run: ChatRun,
  neu: boolean,
): Promise<boolean> {
  const db = getDb();
  const now = run.updatedAt;
  const touch = db.update(chats).set({
    updatedAt: now,
    // Gegen die aktuelle Zeile ausgewertet, damit eine gleichzeitige manuelle Umbenennung gewinnt.
    title: sql`case when ${chats.titleManual} = false and ${chats.title} = 'Neuer Chat'
      then ${request.question.replace(/\s+/g, " ").slice(0, 60)} else ${chats.title} end`,
  }).where(and(eq(chats.id, request.chatId), eq(chats.userId, userId)));

  if (!neu) {
    const [geaendert] = await db.batch([
      db.update(chatRuns).set({ status: "streaming", attempt: run.attempt, updatedAt: now })
        .where(and(eq(chatRuns.id, run.id), ne(chatRuns.status, "completed"), eq(chatRuns.attempt, run.attempt - 1)))
        .returning({ id: chatRuns.id }),
      // Nur zuruecksetzen, wenn das Update oben gegriffen hat.
      db.update(messages).set({ content: "", sources: [], steps: [], status: "streaming", isError: false })
        .where(and(eq(messages.id, run.assistantMessageId),
          sql`exists (select 1 from chat_runs where id = ${run.id}::uuid and attempt = ${run.attempt} and status = 'streaming')`)),
      touch,
    ]);
    return geaendert.length > 0;
  }

  const [eingefuegt] = await db.batch([
    db.insert(chatRuns).values(run).onConflictDoNothing().returning({ id: chatRuns.id }),
    db.insert(messages).values([
      { id: run.userMessageId, chatId: request.chatId, requestId: run.id, role: "user", content: request.question, status: "completed", createdAt: now },
      { id: run.assistantMessageId, chatId: request.chatId, requestId: run.id, role: "assistant", content: "", status: "streaming", createdAt: new Date(now.getTime() + 1) },
    ]).onConflictDoNothing(),
    touch,
  ]);
  return eingefuegt.length > 0;
}

/** Lesen, planen, schreiben — fuer Aufrufer ohne eigenen Vorlauf. */
export async function beginGeneration(userId: string, request: ChatRequest): Promise<ChatRun> {
  const vorlauf = await ladeVorlauf(userId, request);
  const plan = planeGeneration(userId, request, vorlauf.previous);
  if (!plan.neu && plan.run.status === "completed") return plan.run;
  if (await schreibeGeneration(userId, request, plan.run, plan.neu)) return plan.run;

  // Zwischen Lesen und Schreiben hat ein anderer Versuch den Lauf uebernommen.
  const erneut = await existingRun(userId, request);
  if (!erneut) throw new Error("Der Lauf konnte nicht angelegt werden.");
  if (erneut.run.status !== "completed") throw new ValidationError("Diese Antwort wird bereits erstellt.");
  return erneut.run;
}

export async function generationContext(userId: string, request: ChatRequest): Promise<Vorlauf["history"]> {
  await ownChat(userId, request.chatId);
  return zuKontext(await kontextAbfrage(request), request);
}

export async function saveGeneration(run: ChatRun, state: {
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
