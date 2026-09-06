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
 *
 * Alle drei Schranken werden in EINEM Netz-Roundtrip geprueft: zwei
 * Lua-Skripte in einer Pipeline. Vorher waren es vier Aufrufe nacheinander,
 * und jeder davon kostete die volle Latenz zwischen Function und Redis.
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

// --- Kontingente --------------------------------------------------------------

/** Zehn Fragen je Nutzer im gleitenden Minutenfenster. */
const KURZ_LIMIT = 10;
const FENSTER_MS = 60_000;
/**
 * 36 Stunden: laenger als ein Tag, damit ein Zeitzonenversatz den Zaehler
 * nicht vorzeitig verwirft.
 */
const TAG_LEBENSDAUER_SEKUNDEN = 36 * 60 * 60;

/**
 * Nutzerschranken in einem Skript: Kurzfenster und Tageskontingent.
 *
 * Gleitendes Fenster statt Token-Bucket: Wer zehn Fragen in einer Sekunde
 * abschickt, soll nicht neunzig Sekunden warten, sondern gleichmaessig
 * gebremst werden. Das vorherige Fenster zaehlt anteilig mit, gewichtet nach
 * dem Rest des aktuellen Fensters.
 *
 * KEYS[1] aktuelles Kurzfenster, KEYS[2] vorheriges, KEYS[3] Tageszaehler.
 * ARGV[1] Kurzlimit, ARGV[2] Fensterlaenge ms, ARGV[3] Zeitpunkt ms,
 * ARGV[4] Tageslimit, ARGV[5] Lebensdauer des Tageszaehlers in Sekunden.
 *
 * Rueckgabe: {1, tagesstand} bei Zulassung; {0, resetMs}, wenn das
 * Kurzfenster voll ist; {-1, tagesstand}, wenn das Tageskontingent erschoepft
 * ist. Zaehler werden nur bei Zulassung erhoeht: Eine abgewiesene Frage kostet
 * nichts.
 */
export const NUTZER_KONTINGENT_SCRIPT = `
local fenster = tonumber(ARGV[2]); local jetzt = tonumber(ARGV[3])
local vergangen = jetzt % fenster
local gewicht = (fenster - vergangen) / fenster
local stand = tonumber(redis.call('GET', KEYS[2]) or '0') * gewicht + tonumber(redis.call('GET', KEYS[1]) or '0')
if stand >= tonumber(ARGV[1]) then return {0, jetzt - vergangen + fenster} end
local tag = tonumber(redis.call('GET', KEYS[3]) or '0')
if tag >= tonumber(ARGV[4]) then return {-1, tag} end
redis.call('INCR', KEYS[1]); redis.call('PEXPIRE', KEYS[1], fenster * 2)
tag = redis.call('INCR', KEYS[3])
if tag == 1 then redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5])) end
return {1, tag}`;

/**
 * Globale Notbremse, gleitendes Fenster ueber alle Nutzer. Ein eigenes
 * Skript, weil ihre Schluessel nicht im Hash-Slot eines Nutzers liegen
 * koennen. KEYS[1] aktuelles Fenster, KEYS[2] vorheriges; ARGV[1] Limit,
 * ARGV[2] Fensterlaenge ms, ARGV[3] Zeitpunkt ms.
 * Rueckgabe: {1, 0} bei Zulassung, {0, resetMs} sonst.
 */
export const GLOBAL_KONTINGENT_SCRIPT = `
local fenster = tonumber(ARGV[2]); local jetzt = tonumber(ARGV[3])
local vergangen = jetzt % fenster
local gewicht = (fenster - vergangen) / fenster
local stand = tonumber(redis.call('GET', KEYS[2]) or '0') * gewicht + tonumber(redis.call('GET', KEYS[1]) or '0')
if stand >= tonumber(ARGV[1]) then return {0, jetzt - vergangen + fenster} end
redis.call('INCR', KEYS[1]); redis.call('PEXPIRE', KEYS[1], fenster * 2)
return {1, 0}`;

function globalesLimit(): number {
  const obergrenze = Number(optionalEnv("GLOBAL_QUESTIONS_PER_MINUTE") ?? "5000");
  return Number.isFinite(obergrenze) && obergrenze > 0 ? obergrenze : 5000;
}

/** Aktuelles und vorheriges Fenster eines gleitenden Zaehlers. */
export function fensterSchluessel(praefix: string, jetzt: number): [string, string] {
  const fenster = Math.floor(jetzt / FENSTER_MS);
  return [`${praefix}:${fenster}`, `${praefix}:${fenster - 1}`];
}

/**
 * Tageszaehler eines Nutzers. Der Hash-Tag haelt ihn im selben Slot wie seine
 * Kurzfenster, damit ein Skript beide anfassen darf.
 */
export function tagesSchluessel(userId: string, tag = tagesschluessel()): string {
  return `wa:tag:{${userId}}:${tag}`;
}

type Skriptergebnis = [number, number];

/**
 * Prueft alle drei Schranken und erhoeht den Tageszaehler.
 *
 * Reihenfolge der Auswertung mit Absicht: erst das Kurzfenster, dann das
 * Tageskontingent, zuletzt die globale Bremse. Die Skripte laufen in einer
 * Pipeline und zaehlen unabhaengig voneinander; was ein Skript gezaehlt hat,
 * obwohl das andere ablehnt, wird zurueckgegeben, denn die Frage wird nicht
 * gestellt.
 */
export async function pruefeFragekontingent(
  userId: string,
  maxProTag: number,
): Promise<{ verbraucht: number; grenze: number }> {
  const redis = getRedis();
  const jetzt = Date.now();
  const [kurzAktuell, kurzVorher] = fensterSchluessel(`wa:kurz:{${userId}}`, jetzt);
  const [globalAktuell, globalVorher] = fensterSchluessel("wa:global:{alle}", jetzt);
  const tag = tagesSchluessel(userId);

  const pipeline = redis.pipeline();
  pipeline.eval(
    NUTZER_KONTINGENT_SCRIPT,
    [kurzAktuell, kurzVorher, tag],
    [KURZ_LIMIT, FENSTER_MS, jetzt, maxProTag, TAG_LEBENSDAUER_SEKUNDEN],
  );
  pipeline.eval(GLOBAL_KONTINGENT_SCRIPT, [globalAktuell, globalVorher], [globalesLimit(), FENSTER_MS, jetzt]);
  const [nutzer, global] = await pipeline.exec<[Skriptergebnis, Skriptergebnis]>();

  if (nutzer[0] !== 1) {
    if (global[0] === 1) await redis.decr(globalAktuell).catch(() => undefined);
    if (nutzer[0] === 0) throw new RateLimitError(sekundenBis(nutzer[1]));
    throw new QuotaError(
      `Ihr Tageskontingent von ${maxProTag} Fragen ist erschoepft. ` +
        `Morgen steht es wieder zur Verfuegung; fuer mehr braucht es einen hoeheren Plan.`,
      nutzer[1],
      maxProTag,
    );
  }

  if (global[0] !== 1) {
    await redis.pipeline().decr(kurzAktuell).decr(tag).exec().catch(() => undefined);
    throw new RateLimitError(sekundenBis(global[1]));
  }

  return { verbraucht: nutzer[1], grenze: maxProTag };
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
    await getRedis().decr(tagesSchluessel(userId));
  } catch {
    // Ein misslungener Rueckgabeversuch darf die Fehlerbehandlung, in der er
    // steckt, nicht ihrerseits zum Scheitern bringen.
  }
}

/** Aktueller Stand des Tageskontingents, ohne es zu erhoehen. */
export async function leseTagesstand(userId: string): Promise<number> {
  try {
    const wert = await getRedis().get<number>(tagesSchluessel(userId));
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
