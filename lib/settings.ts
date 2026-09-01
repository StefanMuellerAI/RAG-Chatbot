import { decryptSecret, encryptSecret } from "./crypto";
import { requireEnv } from "./env";
import {
  DEFAULT_DAILY_ANSWER_LIMIT,
  PROVIDERS,
  PROVIDER_LABEL,
  isProvider,
  type Provider,
  type PublicSettings,
} from "./providers";
import { getRedis } from "./redis";

export {
  DEFAULT_DAILY_ANSWER_LIMIT,
  MAX_DAILY_ANSWER_LIMIT,
  PROVIDERS,
  PROVIDER_LABEL,
  isProvider,
  type KeyStatus,
  type Provider,
  type PublicSettings,
} from "./providers";

/**
 * Admin-Einstellungen: welcher Anbieter mit welchem Modell antwortet, die
 * dazugehoerigen API-Keys und das Tagesbudget.
 *
 * Es gibt genau einen Datensatz (Redis-Key `settings:v1`). Die Keys liegen
 * verschluesselt darin; an den Browser geht nie mehr als eine Maske.
 */

/** Umgebungsvariable, die als Rueckfallwert fuer den jeweiligen Key gilt. */
const ENV_KEY: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const SETTINGS_KEY = "settings:v1";

type StoredSettings = {
  provider: Provider;
  model: string;
  /** Verschluesselte API-Keys, siehe lib/crypto.ts. */
  keys: Partial<Record<Provider, string>>;
  dailyAnswerLimit: number;
  dailyAnswerLimitPerUser: number | null;
  updatedAt: string;
};

/** Alles, was ein Modellaufruf braucht — mit entschluesseltem Key. */
export type ResolvedSettings = {
  provider: Provider;
  model: string;
  apiKey: string;
  dailyAnswerLimit: number;
  dailyAnswerLimitPerUser: number | null;
};

export class SettingsIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsIncompleteError";
  }
}

/** `sk-ant-…7f3a` — genug, um den Key wiederzuerkennen, zu wenig, um ihn zu nutzen. */
export function maskKey(key: string): string {
  if (key.length < 12) return "••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function envKey(provider: Provider): string | undefined {
  const value = process.env[ENV_KEY[provider]];
  return value && value.length > 0 ? value : undefined;
}

async function loadStored(): Promise<StoredSettings | null> {
  const raw = await getRedis().get<StoredSettings | string>(SETTINGS_KEY);
  if (!raw) return null;
  // Der Upstash-Client parst JSON automatisch; zur Sicherheit beide Faelle.
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as StoredSettings) : raw;
  return {
    provider: isProvider(parsed.provider) ? parsed.provider : "anthropic",
    model: typeof parsed.model === "string" ? parsed.model : "",
    keys: parsed.keys ?? {},
    dailyAnswerLimit:
      typeof parsed.dailyAnswerLimit === "number" ? parsed.dailyAnswerLimit : DEFAULT_DAILY_ANSWER_LIMIT,
    dailyAnswerLimitPerUser:
      typeof parsed.dailyAnswerLimitPerUser === "number" ? parsed.dailyAnswerLimitPerUser : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
  };
}

async function storedKey(stored: StoredSettings | null, provider: Provider): Promise<string | undefined> {
  const encrypted = stored?.keys[provider];
  if (!encrypted) return undefined;
  const { AUTH_SECRET } = requireEnv("AUTH_SECRET");
  return decryptSecret(encrypted, AUTH_SECRET);
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const stored = await loadStored();
  const keys: PublicSettings["keys"] = {};

  for (const provider of PROVIDERS) {
    if (stored?.keys[provider]) {
      try {
        const key = await storedKey(stored, provider);
        keys[provider] = { masked: key ? maskKey(key) : "••••", source: "gespeichert" };
      } catch {
        keys[provider] = { masked: "nicht entschluesselbar — bitte neu eingeben", source: "gespeichert" };
      }
      continue;
    }
    const fromEnv = envKey(provider);
    if (fromEnv) keys[provider] = { masked: maskKey(fromEnv), source: "umgebung" };
  }

  return {
    provider: stored?.provider ?? "anthropic",
    model: stored?.model ?? "",
    keys,
    dailyAnswerLimit: stored?.dailyAnswerLimit ?? DEFAULT_DAILY_ANSWER_LIMIT,
    dailyAnswerLimitPerUser: stored?.dailyAnswerLimitPerUser ?? null,
    updatedAt: stored?.updatedAt ?? null,
  };
}

/**
 * Liefert den Key fuer einen Anbieter: bevorzugt der gespeicherte, sonst die
 * Umgebungsvariable. `override` ist der frisch eingegebene, noch nicht
 * gespeicherte Key aus dem Admin-Formular ("Modelle laden" vor dem Speichern).
 */
export async function resolveApiKey(provider: Provider, override?: string): Promise<string | undefined> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const stored = await loadStored();
  return (await storedKey(stored, provider)) ?? envKey(provider);
}

/** Alles fuer den Modellaufruf im Chat. Wirft, wenn Modell oder Key fehlen. */
export async function resolveSettings(): Promise<ResolvedSettings> {
  const stored = await loadStored();
  const provider = stored?.provider ?? "anthropic";
  const model = stored?.model?.trim() ?? "";

  if (!model) {
    throw new SettingsIncompleteError(
      "Es ist noch kein Modell ausgewaehlt. Bitte im Admin unter 'Modell und API-Key' ein Modell festlegen.",
    );
  }

  const apiKey = (await storedKey(stored, provider)) ?? envKey(provider);
  if (!apiKey) {
    throw new SettingsIncompleteError(
      `Fuer ${PROVIDER_LABEL[provider]} ist kein API-Key hinterlegt. ` +
        `Bitte im Admin unter 'Modell und API-Key' eintragen.`,
    );
  }

  return {
    provider,
    model,
    apiKey,
    dailyAnswerLimit: stored?.dailyAnswerLimit ?? DEFAULT_DAILY_ANSWER_LIMIT,
    dailyAnswerLimitPerUser: stored?.dailyAnswerLimitPerUser ?? null,
  };
}

export type SettingsUpdate = {
  provider: Provider;
  model: string;
  dailyAnswerLimit: number;
  /** Fehlt = kein Limit pro Nutzer. */
  dailyAnswerLimitPerUser?: number | null;
  /**
   * Pro Anbieter: `undefined` = unveraendert lassen, `null` = loeschen,
   * String = neuen Key verschluesselt ablegen.
   */
  keys?: Partial<Record<Provider, string | null>>;
};

export async function updateSettings(update: SettingsUpdate): Promise<PublicSettings> {
  const stored = await loadStored();
  const keys: StoredSettings["keys"] = { ...(stored?.keys ?? {}) };

  for (const provider of PROVIDERS) {
    const change = update.keys?.[provider];
    if (change === undefined) continue;
    if (change === null || change.trim() === "") {
      delete keys[provider];
    } else {
      const { AUTH_SECRET } = requireEnv("AUTH_SECRET");
      keys[provider] = await encryptSecret(change.trim(), AUTH_SECRET);
    }
  }

  const next: StoredSettings = {
    provider: update.provider,
    model: update.model.trim(),
    keys,
    dailyAnswerLimit: update.dailyAnswerLimit,
    dailyAnswerLimitPerUser: update.dailyAnswerLimitPerUser ?? null,
    updatedAt: new Date().toISOString(),
  };

  await getRedis().set(SETTINGS_KEY, JSON.stringify(next));
  return getPublicSettings();
}
