import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { optionalEnv, requireEnv } from "./env";
import { QuotaError, RateLimitError } from "./errors";

/**
 * Drosselung und Tageskontingente.
 *
 * Drei Schranken, die verschiedene Dinge verhindern:
 *
 *   1. Kurzfenster je Nutzer — faengt Klickwiederholungen und Skripte ab, die
 *      im Sekundentakt fragen.
 *   2. Tageskontingent je Nutzer aus dem Plan — begrenzt, was ein einzelnes
 *      Konto insgesamt kosten kann.
 *   3. Globale Notbremse ueber alle Nutzer — schuetzt das Monatsbudget des
 *      Modellanbieters gegen eine Lastspitze, die sich nicht auf einzelne
 *      Konten zurueckfuehren laesst.
 *
 * Die dritte klingt zunaechst ueberfluessig, ist es aber nicht: Die Grenzen der
 * einzelnen Plaene summieren sich bei 15.000 Nutzern zu einem Vielfachen
 * dessen, was der Modellanbieter pro Minute liefert. Ohne eine Obergrenze
 * ueber alles bringt schon ein normaler Montagmorgen die Anwendung in die
 * 429er-Zone des Anbieters — und dort trifft es alle gleichzeitig.
 *
 * Redis und nicht Postgres, weil hier je Frage mindestens ein Schreibvorgang
 * anfaellt. Bei 5.000 Fragen pro Minute waere das eine Schreiblast, die auf der
 * Datenbank nichts zu suchen hat.
 */

let redisZwischenspeicher: Redis | null = null;

export function getRedis(): Redis {
  if (!redisZwischenspeicher) {
    const env = requireEnv("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN");
    redisZwischenspeicher = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      retry: { retries: 1 },
      signal: () => AbortSignal.timeout(5000),
    });
  }
  return redisZwischenspeicher;
}

/**
 * Kurzfenster je Nutzer.
 *
 * Gleitendes Fenster statt Token-Bucket: Wer zehn Fragen in einer Sekunde
 * abschickt, soll nicht neunzig Sekunden warten, sondern gleichmaessig
 * gebremst werden.
 */
let kurzfensterZwischenspeicher: Ratelimit | null = null;

function getKurzfenster(): Ratelimit {
  kurzfensterZwischenspeicher ??= new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(10, "60 s"),
    prefix: "wa:kurz",
    // Zaehlt im Hintergrund weiter, ohne die Antwort aufzuhalten.
    analytics: false,
  });
  return kurzfensterZwischenspeicher;
}

let globalZwischenspeicher: Ratelimit | null = null;

function getGlobal(): Ratelimit {
  if (!globalZwischenspeicher) {
    const obergrenze = Number(optionalEnv("GLOBAL_QUESTIONS_PER_MINUTE") ?? "5000");
    globalZwischenspeicher = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(
        Number.isFinite(obergrenze) && obergrenze > 0 ? obergrenze : 5000,
        "60 s",
      ),
      prefix: "wa:global",
      analytics: false,
    });
  }
  return globalZwischenspeicher;
}

/**
 * Prueft alle drei Schranken und erhoeht den Tageszaehler.
 *
 * Reihenfolge mit Absicht: erst das billige Kurzfenster, dann die globale
 * Bremse, zuletzt das Tageskontingent. Der Tageszaehler wird nur erhoeht, wenn
 * die Frage tatsaechlich gestellt werden darf — sonst wuerde eine abgewiesene
 * Anfrage Kontingent verbrauchen.
 */
export async function pruefeFragekontingent(
  userId: string,
  maxProTag: number,
): Promise<{ verbraucht: number; grenze: number }> {
  const kurz = await getKurzfenster().limit(userId);
  if (!kurz.success) {
    throw new RateLimitError(sekundenBis(kurz.reset));
  }

  const global = await getGlobal().limit("alle");
  if (!global.success) {
    throw new RateLimitError(sekundenBis(global.reset));
  }

  const schluessel = `wa:tag:${userId}:${tagesschluessel()}`;
  const redis = getRedis();

  const verbraucht = await redis.incr(schluessel);

  // Ablauf nur beim ersten Zaehlerstand setzen. Bei jedem Aufruf neu gesetzt
  // wuerde das Fenster mitwandern und der Zaehler nie zurueckgehen.
  if (verbraucht === 1) {
    // 36 Stunden: laenger als ein Tag, damit ein Zeitzonenversatz den Zaehler
    // nicht vorzeitig verwirft.
    await redis.expire(schluessel, 36 * 60 * 60);
  }

  if (verbraucht > maxProTag) {
    throw new QuotaError(
      `Ihr Tageskontingent von ${maxProTag} Fragen ist erschoepft. ` +
        `Morgen steht es wieder zur Verfuegung; fuer mehr braucht es einen hoeheren Plan.`,
      verbraucht - 1,
      maxProTag,
    );
  }

  return { verbraucht, grenze: maxProTag };
}

/**
 * Gibt eine Frage zurueck ins Kontingent.
 *
 * Wird gerufen, wenn die Antwort gar nicht zustande kam — etwa weil das Modell
 * nicht erreichbar war. Wer keine Antwort erhalten hat, soll dafuer nicht
 * bezahlen.
 */
export async function gibFrageZurueck(userId: string): Promise<void> {
  try {
    await getRedis().decr(`wa:tag:${userId}:${tagesschluessel()}`);
  } catch {
    // Ein misslungener Rueckgabeversuch darf die Fehlerbehandlung, in der er
    // steckt, nicht ihrerseits zum Scheitern bringen.
  }
}

/** Aktueller Stand des Tageskontingents, ohne es zu erhoehen. */
export async function leseTagesstand(userId: string): Promise<number> {
  try {
    const wert = await getRedis().get<number>(`wa:tag:${userId}:${tagesschluessel()}`);
    return typeof wert === "number" ? wert : 0;
  } catch {
    return 0;
  }
}

/**
 * Kurzlebiger Zwischenspeicher fuer Werte, die sich selten aendern.
 *
 * Gedacht fuer den Nutzerkontext auf dem Frageweg: Plan, Rolle und
 * Groessenklasse werden bei jeder Frage gebraucht, aendern sich aber nur, wenn
 * ein Admin etwas umstellt. Bei 5.000 Fragen pro Minute waeren das
 * 5.000 Datenbankabfragen fuer Werte, die eine Minute lang dieselben bleiben.
 *
 * Die Lebensdauer ist die Obergrenze dafuer, wie lange eine Planaenderung
 * braucht, bis sie greift. Eine Minute ist der vertretbare Tausch: kurz genug,
 * dass es niemandem auffaellt, lang genug, um die Last zu nehmen.
 */
export async function ausZwischenspeicher<T>(
  schluessel: string,
  lebensdauerSekunden: number,
  laden: () => Promise<T>,
): Promise<T> {
  let redis: Redis;
  try {
    redis = getRedis();
  } catch {
    // Ohne Redis laeuft die Anwendung weiter, nur ohne Zwischenspeicher. Ein
    // fehlender Cache darf nie zum Ausfall fuehren.
    return laden();
  }

  try {
    const gespeichert = await redis.get<T>(schluessel);
    if (gespeichert !== null && gespeichert !== undefined) return gespeichert;
  } catch {
    // Lesefehler: einfach frisch laden.
  }

  const frisch = await laden();

  try {
    await redis.set(schluessel, frisch, { ex: lebensdauerSekunden });
  } catch {
    // Schreibfehler aendern am Ergebnis nichts.
  }

  return frisch;
}

/** Verwirft einen zwischengespeicherten Wert, etwa nach einer Planaenderung. */
export async function verwirfZwischenspeicher(schluessel: string): Promise<void> {
  try {
    await getRedis().del(schluessel);
  } catch {
    // Der Wert verfaellt ohnehin von selbst.
  }
}

export function kontextSchluessel(userId: string): string {
  return `wa:kontext:${userId}`;
}

// --- Sperren ------------------------------------------------------------------

/**
 * Kurzlebige Sperre je Ressource (SET NX EX).
 *
 * Gebraucht fuer die SQLite-Datei einer Tabellen-Sammlung: Sie wird als Ganzes
 * gelesen, veraendert und zurueckgeschrieben. Zwei gleichzeitige Uploads in
 * dieselbe Sammlung wuerden sich ohne Sperre gegenseitig ueberschreiben — der
 * zweite Schreibvorgang liesse die Tabelle des ersten verschwinden.
 *
 * Anders als der Zwischenspeicher oben faellt diese Funktion NICHT still auf
 * "ohne Redis" zurueck: Eine Sperre, die nicht sperrt, ist schlimmer als ein
 * klarer Fehler. Fehlt Redis, wirft `requireEnv` eine MissingConfigError.
 *
 * @returns true, wenn die Sperre erworben wurde; false, wenn sie belegt ist.
 */
export async function erwirbSperre(
  schluessel: string,
  inhaber: string,
  lebensdauerSekunden: number,
): Promise<boolean> {
  const ergebnis = await getRedis().set(schluessel, inhaber, {
    nx: true,
    ex: lebensdauerSekunden,
  });
  return ergebnis === "OK";
}

/**
 * Gibt eine Sperre frei — aber nur die eigene.
 *
 * Vergleich und Loeschen in einem Skript, damit eine abgelaufene und
 * inzwischen von jemand anderem erworbene Sperre nicht versehentlich
 * freigegeben wird.
 */
export const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";
export const RENEW_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] and redis.call('pttl', KEYS[1]) > 0 then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0";

export async function gibSperreFrei(schluessel: string, inhaber: string): Promise<void> {
  try {
    await getRedis().eval(
      RELEASE_LOCK_SCRIPT,
      [schluessel],
      [inhaber],
    );
  } catch (error) {
    // Die Sperre verfaellt ohnehin nach ihrer Lebensdauer. Ein Fehler hier
    // darf den bereits gelungenen Schreibvorgang nicht zum Fehler machen.
    console.warn(`Sperre ${schluessel} konnte nicht freigegeben werden.`, error);
  }
}

export function sperrSchluessel(collectionId: string): string {
  return `wa:lock:${collectionId}`;
}

function tagesschluessel(): string {
  return new Date().toISOString().slice(0, 10);
}

function sekundenBis(zeitpunkt: number): number {
  return Math.max(Math.ceil((zeitpunkt - Date.now()) / 1000), 1);
}
