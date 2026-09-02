import { decryptSecret, encryptSecret } from "./crypto";
import { requireEnv } from "./env";
import { ValidationError } from "./errors";
import { ANBIETER_LABEL, KEY_ANBIETER, type KeyAnbieter } from "./models";
import {
  ladeKeyZeile,
  ladeKeyZeilen,
  loescheKeyZeile,
  schreibeKeyZeile,
} from "./provider-keys-speicher";

/**
 * API-Keys der Modellanbieter.
 *
 * Drei Regeln, die diese Datei durchsetzt:
 *
 *   1. Der Klartext verlaesst den Server nie. Nach aussen geht nur die Maske
 *      ("sk-ant-…7f3a") und der Zeitpunkt der letzten Aenderung.
 *   2. In der Datenbank liegt ein Chiffrat (lib/crypto.ts), der Schluessel dazu
 *      kommt aus PROVIDER_KEY_SECRET. Fehlt die Variable, kann nichts
 *      gespeichert werden — und `requireEnv` sagt das mit Namen.
 *   3. Der entschluesselte Key wird je Instanz eine Minute lang im Modul
 *      gehalten, nicht in Redis: In den Zwischenspeicher gehoert kein Klartext.
 *      Preis dafuer: Ein neu gespeicherter oder geloeschter Key greift auf
 *      anderen Instanzen erst nach bis zu einer Minute.
 */

const LEBENSDAUER_MS = 60_000;

type Eintrag = { key: string | null; gueltigBis: number };

const zwischenspeicher = new Map<KeyAnbieter, Eintrag>();

/** `sk-ant-…7f3a` — genug, um den Key wiederzuerkennen, zu wenig, um ihn zu nutzen. */
export function maskKey(key: string): string {
  if (key.length < 12) return "••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function geheimnis(): string {
  return requireEnv("PROVIDER_KEY_SECRET").PROVIDER_KEY_SECRET;
}

/** Bereinigt eine Eingabe und weist offensichtlich Unbrauchbares ab. */
export function pruefeKeyEingabe(key: unknown): string {
  const wert = typeof key === "string" ? key.trim() : "";
  if (wert.length < 12) {
    throw new ValidationError("Der API-Key ist zu kurz, um gueltig zu sein.");
  }
  if (wert.length > 512 || /\s/.test(wert)) {
    throw new ValidationError("Der API-Key enthaelt Leerzeichen oder ist unplausibel lang.");
  }
  return wert;
}

export async function speichereKey(provider: KeyAnbieter, key: string): Promise<void> {
  const wert = pruefeKeyEingabe(key);
  const encrypted = await encryptSecret(wert, geheimnis());
  await schreibeKeyZeile({ provider, encrypted, masked: maskKey(wert) });
  zwischenspeicher.delete(provider);
}

export async function loescheKey(provider: KeyAnbieter): Promise<void> {
  await loescheKeyZeile(provider);
  zwischenspeicher.delete(provider);
}

export type KeyStatus = {
  masked: string;
  updatedAt: string;
  /** false, wenn das Chiffrat mit dem aktuellen PROVIDER_KEY_SECRET nicht lesbar ist. */
  lesbar: boolean;
};

export type KeyStatusUebersicht = Partial<Record<KeyAnbieter, KeyStatus>>;

/**
 * Status je Anbieter fuer die Oberflaeche: nur Maske und Zeitpunkt.
 *
 * `lesbar` prueft, ob das Chiffrat mit dem aktuellen Geheimnis aufgeht. Nach
 * einem Wechsel von PROVIDER_KEY_SECRET ist es das nicht mehr — und der Admin
 * soll das hier sehen, nicht erst der Nutzer im Chat.
 */
export async function ladeKeyStatus(): Promise<KeyStatusUebersicht> {
  const zeilen = await ladeKeyZeilen();
  const status: KeyStatusUebersicht = {};

  const bekannt = zeilen.filter((zeile) =>
    (KEY_ANBIETER as readonly string[]).includes(zeile.provider),
  );
  const lesbarkeit = await Promise.all(
    bekannt.map((zeile) =>
      decryptSecret(zeile.encrypted, geheimnis()).then(
        () => true,
        () => false,
      ),
    ),
  );

  bekannt.forEach((zeile, index) => {
    status[zeile.provider] = {
      masked: zeile.masked,
      updatedAt: zeile.updatedAt.toISOString(),
      lesbar: lesbarkeit[index],
    };
  });

  return status;
}

/**
 * Entschluesselter Key fuer den Modellaufruf — nur serverseitig zu verwenden.
 *
 * null, wenn keiner hinterlegt ist. Wirft, wenn ein hinterlegter Key nicht
 * entschluesselt werden kann: Dann still auf das Gateway auszuweichen wuerde
 * den Fehler verstecken, und die Meldung aus lib/crypto.ts nennt die Ursache.
 */
export async function ladeKey(provider: KeyAnbieter): Promise<string | null> {
  const jetzt = Date.now();
  const gehalten = zwischenspeicher.get(provider);
  if (gehalten && gehalten.gueltigBis > jetzt) return gehalten.key;

  const zeile = await ladeKeyZeile(provider);
  let key: string | null = null;
  if (zeile) {
    try {
      key = await decryptSecret(zeile.encrypted, geheimnis());
    } catch (error) {
      throw new Error(
        `Der API-Key fuer ${ANBIETER_LABEL[provider]} ist nicht nutzbar: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  zwischenspeicher.set(provider, { key, gueltigBis: jetzt + LEBENSDAUER_MS });
  return key;
}

/** Nur fuer Tests: verwirft den Zwischenspeicher dieser Instanz. */
export function verwirfKeyZwischenspeicher(): void {
  zwischenspeicher.clear();
}
