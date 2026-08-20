import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { chats, messages } from "./db/schema";
import type { StoredSource } from "./db/schema";
import { NotFoundError, ValidationError } from "./errors";

/**
 * Chat-Verlauf in Postgres.
 *
 * Vorher lag er im localStorage. Mit echten Konten ist das nicht mehr
 * vertretbar: Ein Nutzer, der sich anmeldet, erwartet seinen Verlauf auf jedem
 * Geraet — und auf einem geteilten Rechner sah die naechste Person die
 * gespeicherten Fragen samt Dokumentauszuegen.
 *
 * Wie ueberall fuehrt jede Abfrage die Nutzer-ID mit. Eine fremde Chat-ID
 * liefert dasselbe wie eine erfundene.
 */

const MAX_TITEL_LAENGE = 60;
/** Ein Verlauf, den niemand mehr durchsieht, muss auch nicht wachsen. */
const MAX_CHATS_JE_NUTZER = 200;

export type VerlaufNachricht = {
  role: "user" | "assistant";
  content: string;
  sources?: StoredSource[];
  fehler?: boolean;
};

export type VerlaufChat = {
  id: string;
  titel: string;
  titelManuell: boolean;
  geaendertAm: string;
};

/** Liste der Chats — ohne Nachrichten, die kommen erst beim Oeffnen. */
export async function ladeChats(userId: string): Promise<VerlaufChat[]> {
  const zeilen = await getDb()
    .select({
      id: chats.id,
      titel: chats.title,
      titelManuell: chats.titleManual,
      geaendertAm: chats.updatedAt,
    })
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.updatedAt))
    .limit(MAX_CHATS_JE_NUTZER);

  return zeilen.map((zeile) => ({
    ...zeile,
    geaendertAm: zeile.geaendertAm.toISOString(),
  }));
}

export async function ladeNachrichten(
  userId: string,
  chatId: string,
): Promise<VerlaufNachricht[]> {
  // Zugehoerigkeit zuerst, sonst liesse sich mit einer geratenen Chat-ID der
  // Verlauf eines anderen mitlesen.
  await ladeChat(userId, chatId);

  const zeilen = await getDb()
    .select({
      role: messages.role,
      content: messages.content,
      sources: messages.sources,
      isError: messages.isError,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));

  return zeilen.map((zeile) => ({
    role: zeile.role,
    content: zeile.content,
    ...(zeile.sources ? { sources: zeile.sources } : {}),
    ...(zeile.isError ? { fehler: true } : {}),
  }));
}

async function ladeChat(userId: string, chatId: string) {
  const chat = await getDb().query.chats.findFirst({
    where: and(eq(chats.id, chatId), eq(chats.userId, userId)),
  });

  if (!chat) throw new NotFoundError("Der Chat");
  return chat;
}

export async function erstelleChat(userId: string, titel?: string): Promise<VerlaufChat> {
  const [angelegt] = await getDb()
    .insert(chats)
    .values({ userId, title: kuerzeTitel(titel) || "Neuer Chat" })
    .returning({
      id: chats.id,
      titel: chats.title,
      titelManuell: chats.titleManual,
      geaendertAm: chats.updatedAt,
    });

  return { ...angelegt, geaendertAm: angelegt.geaendertAm.toISOString() };
}

/**
 * Haengt eine Nachricht an und schreibt den Titel nach, falls er noch
 * automatisch ist.
 *
 * Der Titel entsteht aus der ersten Frage. Nach einer Umbenennung greift das
 * nicht mehr — `titleManual` verhindert, dass die Wahl des Nutzers
 * ueberschrieben wird.
 */
export async function haengeNachrichtAn(
  userId: string,
  chatId: string,
  nachricht: VerlaufNachricht,
): Promise<void> {
  const chat = await ladeChat(userId, chatId);
  const db = getDb();

  if (!nachricht.content.trim()) {
    throw new ValidationError("Eine leere Nachricht wird nicht gespeichert.");
  }

  await db.insert(messages).values({
    chatId,
    role: nachricht.role,
    content: nachricht.content,
    sources: nachricht.sources ?? null,
    isError: nachricht.fehler ?? false,
  });

  const neuerTitel =
    !chat.titleManual && chat.title === "Neuer Chat" && nachricht.role === "user"
      ? kuerzeTitel(nachricht.content)
      : null;

  await db
    .update(chats)
    .set({ updatedAt: new Date(), ...(neuerTitel ? { title: neuerTitel } : {}) })
    .where(eq(chats.id, chatId));
}

export async function benenneChatUm(
  userId: string,
  chatId: string,
  titel: string,
): Promise<void> {
  await ladeChat(userId, chatId);

  const sauber = titel.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!sauber) throw new ValidationError("Der Titel darf nicht leer sein.");

  await getDb()
    .update(chats)
    .set({ title: sauber, titleManual: true, updatedAt: new Date() })
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
}

export async function loescheChat(userId: string, chatId: string): Promise<void> {
  await ladeChat(userId, chatId);

  // Die Nachrichten gehen per ON DELETE CASCADE mit.
  await getDb()
    .delete(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
}

export async function loescheAlleChats(userId: string): Promise<number> {
  const entfernt = await getDb()
    .delete(chats)
    .where(eq(chats.userId, userId))
    .returning({ id: chats.id });

  return entfernt.length;
}

/**
 * Uebernimmt einen im Browser liegenden Verlauf.
 *
 * Wird genau einmal aufgerufen, wenn ein Nutzer mit alten localStorage-Daten
 * sich erstmals anmeldet. Ohne diesen Weg waeren die bisherigen Gespraeche mit
 * der Umstellung verloren — nicht dramatisch, aber unnoetig.
 */
export async function uebernehmeVerlauf(
  userId: string,
  mitgebracht: { titel: string; nachrichten: VerlaufNachricht[] }[],
): Promise<number> {
  const db = getDb();
  let uebernommen = 0;

  // Begrenzt, damit ein manipulierter Browser-Speicher nicht beliebig viele
  // Zeilen anlegen kann.
  for (const alterChat of mitgebracht.slice(0, 50)) {
    const gueltige = alterChat.nachrichten
      .filter(
        (nachricht) =>
          (nachricht.role === "user" || nachricht.role === "assistant") &&
          typeof nachricht.content === "string" &&
          nachricht.content.trim().length > 0,
      )
      .slice(0, 100);

    if (gueltige.length === 0) continue;

    const [angelegt] = await db
      .insert(chats)
      .values({
        userId,
        title: kuerzeTitel(alterChat.titel) || "Uebernommener Chat",
        titleManual: true,
      })
      .returning({ id: chats.id });

    await db.insert(messages).values(
      gueltige.map((nachricht) => ({
        chatId: angelegt.id,
        role: nachricht.role,
        content: nachricht.content.slice(0, 20_000),
        sources: nachricht.sources ?? null,
        isError: nachricht.fehler ?? false,
      })),
    );

    uebernommen += 1;
  }

  return uebernommen;
}

function kuerzeTitel(wert: unknown): string {
  const text = String(wert ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= MAX_TITEL_LAENGE
    ? text
    : `${text.slice(0, MAX_TITEL_LAENGE).trimEnd()}…`;
}
