/**
 * Reine Konstanten und Typen rund um die Modellanbieter — ohne Server-
 * Abhaengigkeiten, damit auch Client-Komponenten sie importieren koennen.
 */

export type Provider = "anthropic" | "openai";

export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export const DEFAULT_DAILY_ANSWER_LIMIT = 200;
export const MAX_DAILY_ANSWER_LIMIT = 100_000;

export type ModelInfo = {
  id: string;
  label: string;
};

export type KeyStatus = {
  masked: string;
  /** Woher der Key stammt — der Admin soll sehen, ob er den Umgebungswert nutzt. */
  source: "gespeichert" | "umgebung";
};

/** Die Form der Einstellungen, die der Browser zu sehen bekommt. */
export type PublicSettings = {
  provider: Provider;
  model: string;
  keys: Partial<Record<Provider, KeyStatus>>;
  /** Globales Tagesbudget an Antworten. */
  dailyAnswerLimit: number;
  /** Tagesbudget je Nutzer; `null` = kein eigenes Limit. */
  dailyAnswerLimitPerUser: number | null;
  updatedAt: string | null;
};
