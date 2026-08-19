/**
 * Chat-Historie im Browser.
 *
 * Der Verlauf liegt in `localStorage` und wird ueber `useSyncExternalStore`
 * gelesen. Das ist hier nicht Geschmackssache: `localStorage` existiert beim
 * Server-Rendern nicht, und der naheliegende Weg — im Effekt lesen und per
 * setState nachziehen — wuerde einerseits eine Hydration-Abweichung erzeugen
 * und andererseits gegen die Regel `react-hooks/set-state-in-effect` verstossen,
 * die in diesem Projekt ein Fehler ist. `useSyncExternalStore` ist der dafuer
 * vorgesehene Weg; die Synchronisierung ueber mehrere Tabs faellt als Zugabe ab.
 */

export type Quelle = {
  n: number;
  filename: string;
  location: string | null;
  score: number;
  snippet: string;
};

export type Nachricht = {
  role: "user" | "assistant";
  content: string;
  sources?: Quelle[];
  fehler?: boolean;
};

export type Chat = {
  id: string;
  titel: string;
  /** Nach einer Umbenennung darf der Auto-Titel nicht mehr eingreifen. */
  titelManuell: boolean;
  nachrichten: Nachricht[];
  erstelltAm: string;
  geaendertAm: string;
};

type Stand = {
  chats: Chat[];
  aktiveId: string | null;
};

/** Das `v1` erlaubt spaeter eine Migration, ohne alte Staende falsch zu deuten. */
const SCHLUESSEL = "rag-chat-verlauf-v1";

/** localStorage fasst rund 5 MB, und Fundstellen-Auszuege summieren sich. */
const MAX_CHATS = 50;
const MAX_TITEL_LAENGE = 60;

const LEER: Stand = Object.freeze({ chats: [], aktiveId: null }) as Stand;

/**
 * Der zuletzt gelesene Stand. `getSnapshot` MUSS bei unveraenderten Daten
 * dieselbe Referenz liefern — bei jedem Aufruf frisch zu parsen ergaebe jedes
 * Mal ein neues Objekt, React saehe eine Aenderung, rendert, parst erneut, und
 * die Schleife steht.
 */
let zwischenspeicher: Stand | null = null;

const abonnenten = new Set<() => void>();

// --- Lesen -----------------------------------------------------------------

function lies(): Stand {
  if (typeof window === "undefined") return LEER;

  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    if (!roh) return LEER;

    const geparst = JSON.parse(roh) as Partial<Stand>;
    if (!Array.isArray(geparst.chats)) return LEER;

    // Ein einzelner beschaedigter Eintrag darf nicht den ganzen Verlauf kippen.
    const chats = geparst.chats.filter(istChat);
    const aktiveId =
      typeof geparst.aktiveId === "string" && chats.some((chat) => chat.id === geparst.aktiveId)
        ? geparst.aktiveId
        : null;

    return { chats, aktiveId };
  } catch {
    return LEER;
  }
}

function istChat(wert: unknown): wert is Chat {
  if (!wert || typeof wert !== "object") return false;
  const chat = wert as Partial<Chat>;
  return (
    typeof chat.id === "string" &&
    typeof chat.titel === "string" &&
    Array.isArray(chat.nachrichten) &&
    typeof chat.geaendertAm === "string"
  );
}

export function getSnapshot(): Stand {
  zwischenspeicher ??= lies();
  return zwischenspeicher;
}

export function getServerSnapshot(): Stand {
  return LEER;
}

export function subscribe(beiAenderung: () => void): () => void {
  abonnenten.add(beiAenderung);

  // Ein anderer Tab hat geschrieben — Zwischenspeicher verwerfen und neu lesen.
  const beiSpeicher = (ereignis: StorageEvent) => {
    if (ereignis.key !== null && ereignis.key !== SCHLUESSEL) return;
    zwischenspeicher = null;
    abonnenten.forEach((abonnent) => abonnent());
  };

  window.addEventListener("storage", beiSpeicher);

  return () => {
    abonnenten.delete(beiAenderung);
    window.removeEventListener("storage", beiSpeicher);
  };
}

// --- Schreiben -------------------------------------------------------------

function schreib(stand: Stand): void {
  // Aelteste Chats fallen hinten raus. `chats` ist stets nach letzter Aenderung
  // sortiert, der Schnitt trifft also die am laengsten unberuehrten.
  const gekuerzt: Stand = {
    chats: stand.chats.slice(0, MAX_CHATS),
    aktiveId: stand.aktiveId,
  };

  zwischenspeicher = gekuerzt;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SCHLUESSEL, JSON.stringify(gekuerzt));
    } catch {
      // Speicher voll: den aeltesten Chat opfern und einmal erneut versuchen.
      // Lieber ein Chat weniger als eine Ausnahme, die die Oberflaeche anhaelt.
      try {
        const knapper: Stand = { ...gekuerzt, chats: gekuerzt.chats.slice(0, -1) };
        window.localStorage.setItem(SCHLUESSEL, JSON.stringify(knapper));
        zwischenspeicher = knapper;
      } catch {
        // Auch das schlaegt fehl — der Verlauf bleibt dann eben nur im Speicher
        // dieser Sitzung. Die laufende Unterhaltung soll deswegen nicht abbrechen.
      }
    }
  }

  abonnenten.forEach((abonnent) => abonnent());
}

/** Sortiert absteigend nach letzter Aenderung. */
function sortiert(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.geaendertAm.localeCompare(a.geaendertAm));
}

function jetzt(): string {
  return new Date().toISOString();
}

// --- Mutationen ------------------------------------------------------------

/** Legt einen leeren Chat an und macht ihn aktiv. Gibt dessen ID zurueck. */
export function neuerChat(): string {
  const stand = getSnapshot();

  // Ist der aktive Chat noch unbenutzt, bleibt es bei ihm. Sonst saeht
  // wiederholtes Klicken eine Reihe gleichnamiger leerer Eintraege.
  const aktiv = stand.chats.find((chat) => chat.id === stand.aktiveId);
  if (aktiv && aktiv.nachrichten.length === 0) return aktiv.id;

  const zeitpunkt = jetzt();

  const chat: Chat = {
    id: crypto.randomUUID(),
    titel: "Neuer Chat",
    titelManuell: false,
    nachrichten: [],
    erstelltAm: zeitpunkt,
    geaendertAm: zeitpunkt,
  };

  schreib({ chats: [chat, ...stand.chats], aktiveId: chat.id });
  return chat.id;
}

/**
 * Haengt eine Nachricht an. Legt den Chat an, falls noch keiner aktiv ist —
 * dadurch entsteht beim ersten Absenden automatisch ein Eintrag, ohne dass
 * leere Chats herumliegen, nur weil jemand die Seite geoeffnet hat.
 */
export function nachrichtAnhaengen(chatId: string, nachricht: Nachricht): void {
  const stand = getSnapshot();
  const chat = stand.chats.find((eintrag) => eintrag.id === chatId);
  if (!chat) return;

  const nachrichten = [...chat.nachrichten, nachricht];
  const aktualisiert: Chat = {
    ...chat,
    nachrichten,
    geaendertAm: jetzt(),
    titel: chat.titelManuell ? chat.titel : autoTitel(nachrichten, chat.titel),
  };

  schreib({
    chats: sortiert([aktualisiert, ...stand.chats.filter((eintrag) => eintrag.id !== chatId)]),
    aktiveId: stand.aktiveId,
  });
}

/** Der Titel entsteht aus der ersten Frage — knapp und wiedererkennbar. */
function autoTitel(nachrichten: Nachricht[], bisher: string): string {
  const erste = nachrichten.find((nachricht) => nachricht.role === "user");
  if (!erste) return bisher;

  const text = erste.content.replace(/\s+/g, " ").trim();
  if (!text) return bisher;

  return text.length <= MAX_TITEL_LAENGE ? text : `${text.slice(0, MAX_TITEL_LAENGE).trimEnd()}…`;
}

export function umbenennen(chatId: string, titel: string): void {
  const stand = getSnapshot();
  const sauber = titel.replace(/\s+/g, " ").trim();
  if (!sauber) return;

  schreib({
    chats: stand.chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, titel: sauber.slice(0, 120), titelManuell: true }
        : chat,
    ),
    aktiveId: stand.aktiveId,
  });
}

export function loeschen(chatId: string): void {
  const stand = getSnapshot();
  const uebrig = stand.chats.filter((chat) => chat.id !== chatId);

  // War der geloeschte Chat aktiv, rueckt der zuletzt geaenderte nach.
  const aktiveId = stand.aktiveId === chatId ? (uebrig[0]?.id ?? null) : stand.aktiveId;

  schreib({ chats: uebrig, aktiveId });
}

export function alleLoeschen(): void {
  schreib({ chats: [], aktiveId: null });
}

export function aktivSetzen(chatId: string | null): void {
  const stand = getSnapshot();
  if (stand.aktiveId === chatId) return;

  schreib({ chats: stand.chats, aktiveId: chatId });
}
