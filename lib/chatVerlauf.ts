/**
 * Chat-Verlauf im Browser — als Fassade vor der Serverschicht.
 *
 * Vorher lag der Verlauf im localStorage. Mit echten Konten ist das nicht mehr
 * vertretbar: Wer sich anmeldet, erwartet seine Gespraeche auf jedem Geraet, und
 * auf einem geteilten Rechner sah die naechste Person die gespeicherten Fragen
 * samt Dokumentauszuegen. Die Daten liegen jetzt in Postgres.
 *
 * Der Zugriff laeuft weiter ueber `useSyncExternalStore`, und das ist hier nicht
 * Geschmackssache: Ein Speicher, den mehrere Komponenten lesen und den
 * Netzantworten von aussen veraendern, ist genau der Fall, fuer den es gedacht
 * ist. `getSnapshot` MUSS bei unveraenderten Daten dieselbe Referenz liefern —
 * ein bei jedem Aufruf neu gebautes Objekt saehe React als Aenderung, rendert,
 * baut erneut, und die Schleife steht.
 *
 * Die Nachrichten werden je Chat erst beim Oeffnen geholt. Bei 200 Chats mit
 * hunderten Nachrichten waere ein vollstaendiger Verlauf beim Seitenaufbau
 * mehrere Megabyte fuer etwas, das niemand liest.
 */

import type { ToolStep } from "./tools-types";

export type Quelle = {
  n: number;
  filename: string;
  location: string | null;
  score: number;
  snippet: string;
  collectionName?: string;
};

export type Nachricht = {
  role: "user" | "assistant";
  content: string;
  sources?: Quelle[];
  /** Werkzeugaufrufe (Suche, SQL, Cypher), die zu dieser Antwort gefuehrt haben. */
  steps?: ToolStep[];
  fehler?: boolean;
};

export type Chat = {
  id: string;
  titel: string;
  titelManuell: boolean;
  geaendertAm: string;
};

type Stand = {
  chats: Chat[];
  aktiveId: string | null;
  /** Nachrichten je Chat, sobald geladen. */
  nachrichten: Record<string, Nachricht[]>;
  /** Erst nach dem ersten Laden steht fest, ob es Chats gibt. */
  geladen: boolean;
  fehler: string | null;
};

const LEER: Stand = Object.freeze({
  chats: [],
  aktiveId: null,
  nachrichten: {},
  geladen: false,
  fehler: null,
}) as Stand;

let stand: Stand = LEER;
const abonnenten = new Set<() => void>();

function setze(teil: Partial<Stand>): void {
  stand = { ...stand, ...teil };
  abonnenten.forEach((abonnent) => abonnent());
}

export function getSnapshot(): Stand {
  return stand;
}

export function getServerSnapshot(): Stand {
  return LEER;
}

export function subscribe(beiAenderung: () => void): () => void {
  abonnenten.add(beiAenderung);
  return () => abonnenten.delete(beiAenderung);
}

// --- Laden ------------------------------------------------------------------

/** Der alte Browser-Speicher. Wird beim ersten Laden uebernommen und entfernt. */
const ALTER_SCHLUESSEL = "rag-chat-verlauf-v1";

let initialisierungLaeuft = false;

/**
 * Holt die Chatliste. Mehrfachaufrufe sind unschaedlich — die Ansicht ruft
 * beim Aufbau, und React ruft Effekte in der Entwicklung doppelt.
 */
export async function initialisiere(): Promise<void> {
  if (initialisierungLaeuft || stand.geladen) return;
  initialisierungLaeuft = true;

  try {
    const mitgebracht = lieseAltenVerlauf();

    if (mitgebracht.length > 0) {
      // Uebernahme und Liste in einem Aufruf: Die Antwort enthaelt die
      // vollstaendige Liste, ein zweiter Abruf waere ueberfluessig.
      const antwort = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uebernahme: mitgebracht }),
      });

      if (antwort.ok) {
        const daten = (await antwort.json()) as { chats: Chat[] };
        // Erst nach bestaetigter Uebernahme entfernen. Anders herum waere der
        // Verlauf bei einem Netzfehler weg.
        window.localStorage.removeItem(ALTER_SCHLUESSEL);
        setze({ chats: daten.chats, geladen: true, fehler: null });
        return;
      }
    }

    const antwort = await fetch("/api/chats");
    if (!antwort.ok) throw new Error(`Status ${antwort.status}`);

    const daten = (await antwort.json()) as { chats: Chat[] };
    setze({ chats: daten.chats, geladen: true, fehler: null });
  } catch (error) {
    setze({
      geladen: true,
      fehler:
        error instanceof Error
          ? `Der Verlauf konnte nicht geladen werden: ${error.message}`
          : "Der Verlauf konnte nicht geladen werden.",
    });
  } finally {
    initialisierungLaeuft = false;
  }
}

function lieseAltenVerlauf(): { titel: string; nachrichten: Nachricht[] }[] {
  if (typeof window === "undefined") return [];

  try {
    const roh = window.localStorage.getItem(ALTER_SCHLUESSEL);
    if (!roh) return [];

    const geparst = JSON.parse(roh) as {
      chats?: { titel?: string; nachrichten?: Nachricht[] }[];
    };

    if (!Array.isArray(geparst.chats)) return [];

    return geparst.chats
      .filter((chat) => Array.isArray(chat?.nachrichten) && chat.nachrichten.length > 0)
      .map((chat) => ({
        titel: String(chat.titel ?? "Uebernommener Chat"),
        nachrichten: chat.nachrichten as Nachricht[],
      }));
  } catch {
    // Ein beschaedigter Altbestand ist kein Grund, die Anwendung anzuhalten.
    return [];
  }
}

// --- Auswahl ----------------------------------------------------------------

export async function waehleChat(chatId: string | null): Promise<void> {
  if (stand.aktiveId === chatId) return;

  setze({ aktiveId: chatId });
  if (chatId) await ladeNachrichten(chatId);
}

async function ladeNachrichten(chatId: string): Promise<void> {
  if (stand.nachrichten[chatId]) return;

  try {
    const antwort = await fetch(`/api/chats/${chatId}`);
    if (!antwort.ok) return;

    const daten = (await antwort.json()) as { nachrichten: Nachricht[] };
    setze({ nachrichten: { ...stand.nachrichten, [chatId]: daten.nachrichten } });
  } catch {
    // Beim naechsten Wechsel wird es erneut versucht.
  }
}

/** Nachrichten des aktiven Chats, oder eine leere Liste. */
export function nachrichtenVon(chatId: string | null): Nachricht[] {
  return chatId ? (stand.nachrichten[chatId] ?? []) : [];
}

// --- Mutationen -------------------------------------------------------------

/** Legt einen Chat an und macht ihn aktiv. Gibt dessen ID zurueck. */
export async function neuerChat(): Promise<string | null> {
  // Ist der aktive Chat noch unbenutzt, bleibt es bei ihm. Sonst saeht
  // wiederholtes Klicken eine Reihe gleichnamiger leerer Eintraege.
  const aktiv = stand.chats.find((chat) => chat.id === stand.aktiveId);
  if (aktiv && (stand.nachrichten[aktiv.id]?.length ?? 0) === 0) return aktiv.id;

  try {
    const antwort = await fetch("/api/chats", { method: "POST" });
    if (!antwort.ok) throw new Error(`Status ${antwort.status}`);

    const { chat } = (await antwort.json()) as { chat: Chat };

    setze({
      chats: [chat, ...stand.chats],
      aktiveId: chat.id,
      nachrichten: { ...stand.nachrichten, [chat.id]: [] },
    });

    return chat.id;
  } catch (error) {
    setze({
      fehler:
        error instanceof Error
          ? `Der Chat konnte nicht angelegt werden: ${error.message}`
          : "Der Chat konnte nicht angelegt werden.",
    });
    return null;
  }
}

/**
 * Haengt eine Nachricht an — zuerst in der Ansicht, dann auf dem Server.
 *
 * Die Reihenfolge ist Absicht: Die eigene Frage soll ohne Verzoegerung
 * erscheinen. Scheitert das Speichern, bleibt sie sichtbar und es erscheint ein
 * Hinweis — sie aus der laufenden Unterhaltung zu entfernen waere
 * verwirrender als ein nicht gesicherter Verlauf.
 */
export async function nachrichtAnhaengen(
  chatId: string,
  nachricht: Nachricht,
): Promise<void> {
  const bisher = stand.nachrichten[chatId] ?? [];
  const jetzt = new Date().toISOString();

  setze({
    nachrichten: { ...stand.nachrichten, [chatId]: [...bisher, nachricht] },
    chats: sortiert(
      stand.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              geaendertAm: jetzt,
              titel:
                !chat.titelManuell && chat.titel === "Neuer Chat" && nachricht.role === "user"
                  ? autoTitel(nachricht.content)
                  : chat.titel,
            }
          : chat,
      ),
    ),
  });

  try {
    const antwort = await fetch(`/api/chats/${chatId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nachricht }),
    });

    if (!antwort.ok) throw new Error(`Status ${antwort.status}`);
  } catch {
    setze({
      fehler:
        "Diese Nachricht konnte nicht im Verlauf gespeichert werden. Die Unterhaltung laeuft weiter.",
    });
  }
}

export async function umbenennen(chatId: string, titel: string): Promise<void> {
  const sauber = titel.replace(/\s+/g, " ").trim();
  if (!sauber) return;

  setze({
    chats: stand.chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, titel: sauber.slice(0, 120), titelManuell: true }
        : chat,
    ),
  });

  await fetch(`/api/chats/${chatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titel: sauber }),
  }).catch(() => setze({ fehler: "Der Chat konnte nicht umbenannt werden." }));
}

export async function loeschen(chatId: string): Promise<void> {
  const uebrig = stand.chats.filter((chat) => chat.id !== chatId);
  const { [chatId]: entfernt, ...restNachrichten } = stand.nachrichten;
  void entfernt;

  // War der geloeschte Chat aktiv, ruckt der zuletzt geaenderte nach.
  const aktiveId = stand.aktiveId === chatId ? (uebrig[0]?.id ?? null) : stand.aktiveId;

  setze({ chats: uebrig, aktiveId, nachrichten: restNachrichten });

  await fetch(`/api/chats/${chatId}`, { method: "DELETE" }).catch(() =>
    setze({ fehler: "Der Chat konnte nicht geloescht werden." }),
  );

  if (aktiveId) await ladeNachrichten(aktiveId);
}

export async function alleLoeschen(): Promise<void> {
  setze({ chats: [], aktiveId: null, nachrichten: {} });

  await fetch("/api/chats", { method: "DELETE" }).catch(() =>
    setze({ fehler: "Die Chats konnten nicht geloescht werden." }),
  );
}

export function verwerfeFehler(): void {
  if (stand.fehler) setze({ fehler: null });
}

// --- Hilfen -----------------------------------------------------------------

function sortiert(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.geaendertAm.localeCompare(a.geaendertAm));
}

const MAX_TITEL_LAENGE = 60;

/** Der Titel entsteht aus der ersten Frage — knapp und wiedererkennbar. */
function autoTitel(inhalt: string): string {
  const text = inhalt.replace(/\s+/g, " ").trim();
  if (!text) return "Neuer Chat";
  return text.length <= MAX_TITEL_LAENGE
    ? text
    : `${text.slice(0, MAX_TITEL_LAENGE).trimEnd()}…`;
}
