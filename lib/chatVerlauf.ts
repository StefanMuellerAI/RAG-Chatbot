/** Browser cache only. The chat endpoint owns persistence and request identity. */
import type { ToolStep } from "./tools-types";

export type Quelle = {
  n: number; filename: string; location: string | null; score: number; snippet: string;
  collectionName?: string; documentId?: string; downloadUrl?: string;
};
export type Nachricht = {
  id: string; role: "user" | "assistant"; content: string; sources?: Quelle[]; steps?: ToolStep[];
  status?: "pending" | "streaming" | "completed" | "failed" | "aborted" | "interrupted";
  requestId?: string | null; fehler?: boolean;
  feedback?: { helpful: boolean; reason?: string | null } | null;
  request?: { question: string; collectionIds?: string[] | null; detail?: "compact" | "detailed" } | null;
};
export type Chat = { id: string; titel: string; titelManuell: boolean; geaendertAm: string };
export type ChatLadestand = {
  status: "loading" | "ready" | "error"; mehrLaedt: boolean; nextCursor: string | null; fehler: string | null;
};
type Stand = {
  chats: Chat[]; aktiveId: string | null; nachrichten: Record<string, Nachricht[]>;
  chatLadestand: Record<string, ChatLadestand>; geladen: boolean; listeLaedt: boolean;
  nextCursor: string | null; fehler: string | null;
};
const LEER: Stand = {
  chats: [], aktiveId: null, nachrichten: {}, chatLadestand: {},
  geladen: false, listeLaedt: false, nextCursor: null, fehler: null,
};
let stand = LEER;
let konto: string | undefined;
let generation = 0;
let auswahlRevision = 0;
const abonnenten = new Set<() => void>();
const abrufe = new Map<string, Promise<boolean>>();
let anlegen: Promise<string | null> | null = null;
function setze(teil: Partial<Stand>) {
  stand = { ...stand, ...teil };
  abonnenten.forEach((fn) => fn());
}
function ladestand(id: string, teil: Partial<ChatLadestand>) {
  const vorher = stand.chatLadestand[id] ?? {
    status: "loading", mehrLaedt: false, nextCursor: null, fehler: null,
  };
  setze({ chatLadestand: { ...stand.chatLadestand, [id]: { ...vorher, ...teil } } });
}
export const getSnapshot = () => stand;
export const getServerSnapshot = () => LEER;
export function subscribe(fn: () => void) {
  abonnenten.add(fn);
  return () => { abonnenten.delete(fn); };
}
/** Never reuse the previous account's in-memory conversations. */
export async function initialisiere(userId?: string, erneut = false): Promise<void> {
  if (konto !== userId) {
    konto = userId;
    generation += 1;
    abrufe.clear();
    anlegen = null;
    setze(LEER);
  }
  if (stand.listeLaedt || (stand.geladen && !erneut)) return;
  await ladeChatliste(false);
}
async function meldung(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error || `Der Server antwortete mit Status ${response.status}.`;
}
async function ladeChatliste(mehr: boolean): Promise<void> {
  if (stand.listeLaedt || (mehr && !stand.nextCursor)) return;
  const g = generation;
  const bekannteIds = new Set(stand.chats.map((chat) => chat.id));
  const params = new URLSearchParams({ limit: "30" });
  if (mehr && stand.nextCursor) params.set("before", stand.nextCursor);
  setze({ listeLaedt: true, fehler: null });
  try {
    const response = await fetch(`/api/chats?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(await meldung(response));
    const daten = await response.json() as { chats: Chat[]; nextCursor?: string | null };
    if (g !== generation) return;
    // Chats created while this GET was in flight must not disappear from the sidebar.
    const vorher = mehr ? stand.chats : stand.chats.filter((chat) => !bekannteIds.has(chat.id));
    const ids = new Set(vorher.map((chat) => chat.id));
    setze({ chats: [...vorher, ...daten.chats.filter((chat) => !ids.has(chat.id))],
      nextCursor: daten.nextCursor ?? null, geladen: true });
  } catch (error) {
    if (g === generation) setze({ geladen: true, fehler: fehlertext(error, "Der Verlauf konnte nicht geladen werden.") });
  } finally {
    if (g === generation) setze({ listeLaedt: false });
  }
}
export const ladeWeitereChats = () => ladeChatliste(true);
export async function waehleChat(chatId: string | null): Promise<void> {
  auswahlRevision += 1;
  if (chatId && !/^[a-zA-Z0-9-]+$/.test(chatId)) {
    setze({ aktiveId: null, fehler: "Die Chat-Adresse ist ungültig." });
    return;
  }
  setze({ aktiveId: chatId });
  if (chatId) await ladeNachrichten(chatId);
}
/** A successful response replaces optimistic messages only after it is received. */
export function ladeNachrichten(chatId: string, erneut = false, mehr = false): Promise<boolean> {
  const key = `${generation}:${chatId}:${mehr ? "older" : "latest"}`;
  const pending = abrufe.get(key);
  if (pending) return pending;
  const zustand = stand.chatLadestand[chatId];
  if (!erneut && !mehr && zustand?.status === "ready") return Promise.resolve(true);
  if (mehr && !zustand?.nextCursor) return Promise.resolve(true);
  const g = generation;
  const params = new URLSearchParams({ limit: "40" });
  if (mehr && zustand?.nextCursor) params.set("before", zustand.nextCursor);
  ladestand(chatId, mehr ? { mehrLaedt: true, fehler: null } : { status: "loading", fehler: null });
  const promise = (async () => {
    try {
      const response = await fetch(`/api/chats/${chatId}?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(await meldung(response));
      const daten = await response.json() as { chat?: Chat; messages: Nachricht[]; nextCursor?: string | null };
      if (g !== generation) return false;
      const aktuell = stand.nachrichten[chatId] ?? [];
      const ids = new Set(aktuell.map((n) => n.id));
      const nachrichten = mehr
        ? [...daten.messages.filter((n) => !ids.has(n.id)), ...aktuell]
        : daten.messages;
      setze({ nachrichten: { ...stand.nachrichten, [chatId]: nachrichten },
        ...(daten.chat ? { chats: sortiert([daten.chat, ...stand.chats.filter((c) => c.id !== chatId)]) } : {}) });
      ladestand(chatId, { status: "ready", mehrLaedt: false, fehler: null, nextCursor: daten.nextCursor ?? null });
      return true;
    } catch (error) {
      if (g === generation) ladestand(chatId, {
        status: mehr ? "ready" : "error", mehrLaedt: false,
        fehler: fehlertext(error, "Die Nachrichten konnten nicht geladen werden."),
      });
      return false;
    } finally { abrufe.delete(key); }
  })();
  abrufe.set(key, promise);
  return promise;
}
export const nachrichtenVon = (id: string | null): Nachricht[] => id ? (stand.nachrichten[id] ?? []) : [];
/** Local recovery copy; this deliberately performs no POST. */
export function merkeAntwort(chatId: string, nachrichten: Nachricht[]) {
  const requestIds = new Set(nachrichten.map((n) => n.requestId).filter(Boolean));
  setze({ nachrichten: { ...stand.nachrichten, [chatId]: [
    ...nachrichtenVon(chatId).filter((n) => !n.requestId || !requestIds.has(n.requestId)), ...nachrichten,
  ] } });
}
export function neuerChat(): Promise<string | null> {
  if (anlegen) return anlegen;
  const aktiv = stand.chats.find((chat) => chat.id === stand.aktiveId);
  if (aktiv && stand.chatLadestand[aktiv.id]?.status === "ready" && nachrichtenVon(aktiv.id).length === 0) {
    return Promise.resolve(aktiv.id);
  }
  const g = generation;
  const auswahl = auswahlRevision;
  anlegen = (async () => {
    try {
      const response = await fetch("/api/chats", { method: "POST", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(await meldung(response));
      const { chat } = await response.json() as { chat: Chat };
      if (g !== generation) return null;
      setze({ chats: [chat, ...stand.chats], ...(auswahl === auswahlRevision ? { aktiveId: chat.id } : {}),
        nachrichten: { ...stand.nachrichten, [chat.id]: [] } });
      ladestand(chat.id, { status: "ready" });
      return chat.id;
    } catch (error) {
      if (g === generation) setze({ fehler: fehlertext(error, "Der Chat konnte nicht angelegt werden.") });
      return null;
    } finally { if (g === generation) anlegen = null; }
  })();
  return anlegen;
}
export async function umbenennen(chatId: string, titel: string): Promise<void> {
  const sauber = titel.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!sauber) return;
  try {
    const response = await fetch(`/api/chats/${chatId}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ titel: sauber }) });
    if (!response.ok) throw new Error(await meldung(response));
    setze({ chats: stand.chats.map((chat) => chat.id === chatId ? { ...chat, titel: sauber, titelManuell: true } : chat) });
  } catch (error) { setze({ fehler: fehlertext(error, "Der Chat konnte nicht umbenannt werden.") }); }
}
export async function loeschen(chatId: string): Promise<void> {
  try {
    const response = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await meldung(response));
    const uebrig = stand.chats.filter((chat) => chat.id !== chatId);
    const nachrichten = { ...stand.nachrichten };
    delete nachrichten[chatId];
    setze({ chats: uebrig, nachrichten });
    if (stand.aktiveId === chatId) await waehleChat(uebrig[0]?.id ?? null);
  } catch (error) { setze({ fehler: fehlertext(error, "Der Chat konnte nicht gelöscht werden.") }); }
}
export async function alleLoeschen(): Promise<void> {
  try {
    const response = await fetch("/api/chats", { method: "DELETE" });
    if (!response.ok) throw new Error(await meldung(response));
    setze({ chats: [], aktiveId: null, nachrichten: {}, chatLadestand: {}, nextCursor: null });
  } catch (error) { setze({ fehler: fehlertext(error, "Die Chats konnten nicht gelöscht werden.") }); }
}
export function verwerfeFehler() { setze({ fehler: null }); }
function sortiert(chats: Chat[]) { return [...chats].sort((a, b) => b.geaendertAm.localeCompare(a.geaendertAm)); }
function fehlertext(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
