/**
 * Modelle: Typen, Standardkatalog, Kostenrechnung und Routing-Entscheidung.
 *
 * Diese Datei ist bewusst frei von Datenbank und Netz, damit Client-Komponenten
 * (Admin-Konsole) die Konstanten importieren koennen und die Funktionen sich
 * ohne Dienste testen lassen. Der Katalog selbst liegt in Postgres (Tabelle
 * models) und wird ueber lib/modellkatalog.ts geladen.
 *
 * Die Preise stehen am Modell, weil jede Antwort in usage_events mit ihren
 * Kosten verbucht wird. Ohne diese Zuordnung ist bei 15.000 Nutzern nicht
 * feststellbar, wer die Rechnung treibt.
 *
 * Kennungen haben die Form "<praefix>/<native-id>". Der Praefix ist der
 * Hersteller (anthropic, openai, google, …), die native Kennung das, was der
 * Anbieter selbst versteht. `provider` sagt, wohin der Aufruf geht:
 * "anthropic" | "openai" direkt an den Anbieter (mit hinterlegtem Key),
 * "gateway" ueber das Vercel AI Gateway.
 */

/** Wohin ein Aufruf geht. */
export type Anbieter = "anthropic" | "openai" | "gateway";

/** Anbieter, fuer die ein eigener API-Key hinterlegt werden kann. */
export const KEY_ANBIETER = ["anthropic", "openai"] as const;
export type KeyAnbieter = (typeof KEY_ANBIETER)[number];

export const ANBIETER: readonly Anbieter[] = ["gateway", "anthropic", "openai"];

export const ANBIETER_LABEL: Record<Anbieter, string> = {
  gateway: "AI Gateway",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function istAnbieter(wert: unknown): wert is Anbieter {
  return typeof wert === "string" && (ANBIETER as readonly string[]).includes(wert);
}

export function istKeyAnbieter(wert: unknown): wert is KeyAnbieter {
  return typeof wert === "string" && (KEY_ANBIETER as readonly string[]).includes(wert);
}

export type ModelInfo = {
  id: string;
  provider: Anbieter;
  label: string;
  /** US-Dollar je 1 Mio. Token. */
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  /** Nur aktive Modelle stehen im Auswahlfeld der Plaene. */
  enabled: boolean;
  sortOrder: number;
};

/**
 * Zulaessige Form einer Kennung: Praefix klein, dann "/", dann die native
 * Kennung des Anbieters (Anthropic nutzt Bindestriche und Datumsanhaenge,
 * OpenAI Punkte, das Gateway teils Doppelpunkte).
 */
export const KENNUNG_MUSTER = /^[a-z0-9.-]+\/[A-Za-z0-9._:-]+$/;
export const KENNUNG_MAX_ZEICHEN = 120;
export const LABEL_MAX_ZEICHEN = 80;

/**
 * Standardkatalog: die drei Gateway-Free-Tier-Modelle, mit denen die Anwendung
 * bisher fest lief. Der Seed legt sie als Katalogeintraege an; sie sind
 * ausserdem der Rueckfall, wenn der Katalog leer ist oder ein Plan eine
 * Kennung traegt, die es dort nicht mehr gibt.
 *
 * Preise in US-Dollar je 1 Mio. Token, Stand August 2026. Cache-Treffer kosten
 * ein Zehntel des Eingabepreises.
 */
export const STANDARD_MODELLE: readonly ModelInfo[] = [
  {
    id: "google/gemini-2.5-flash-lite",
    provider: "gateway",
    label: "Gemini 2.5 Flash Lite — schnell und guenstig",
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.01,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "gateway",
    label: "Gemini 2.5 Flash — ausgewogen",
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.03,
    enabled: true,
    sortOrder: 2,
  },
  {
    id: "openai/gpt-5-mini",
    provider: "gateway",
    label: "GPT-5 mini — hoehere Qualitaet",
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.025,
    enabled: true,
    sortOrder: 3,
  },
] as const;

/** Fallback, falls ein Plan eine unbekannte Modellkennung traegt. */
export const DEFAULT_MODEL_ID = "google/gemini-2.5-flash-lite";

/**
 * Alte Anthropic-Kennungen, die im Free-Tier nicht mehr gehen.
 * Der Seed setzt bestehende Plaene darauf um.
 */
export const MODELL_UMSTELLUNG: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-4.5": "google/gemini-2.5-flash-lite",
  "anthropic/claude-sonnet-5": "google/gemini-2.5-flash",
  "anthropic/claude-opus-5": "openai/gpt-5-mini",
};

/** Eintrag des Standardkatalogs zu einer Kennung — oder das Standardmodell. */
export function standardModell(id: string): ModelInfo {
  return (
    STANDARD_MODELLE.find((model) => model.id === id) ??
    STANDARD_MODELLE.find((model) => model.id === DEFAULT_MODEL_ID) ??
    STANDARD_MODELLE[0]
  );
}

/**
 * Zerlegt "anthropic/claude-sonnet-4-5" in Praefix und native Kennung.
 * Getrennt wird am ERSTEN Schraegstrich; Gateway-Kennungen wie
 * "openai/gpt-4o:extended" behalten den Rest unveraendert.
 */
export function zerlegeKennung(id: string): { praefix: string; nativeId: string } {
  const trenner = id.indexOf("/");
  if (trenner < 0) return { praefix: "", nativeId: id };
  return { praefix: id.slice(0, trenner), nativeId: id.slice(trenner + 1) };
}

/**
 * Entscheidet, ob ein Aufruf direkt zum Anbieter geht oder ueber das Gateway.
 *
 * Direkt nur, wenn das Modell einen Key-Anbieter nennt UND ein Key hinterlegt
 * ist. Alles andere — Gateway-Modelle, fehlender Key — laeuft ueber das
 * Gateway, das damit der Rueckfall bleibt, der immer geht.
 */
export function waehleAnbindung(
  model: Pick<ModelInfo, "provider">,
  keyVorhanden: boolean,
): "direkt" | "gateway" {
  return istKeyAnbieter(model.provider) && keyVorhanden ? "direkt" : "gateway";
}

/**
 * Modell fuer den Werkzeugmodus (SQL, Cypher, Suche ueber mehrere Sammlungen).
 *
 * Gemini 2.5 Flash Lite liefert nach einem Werkzeugergebnis regelmaessig
 * leeren Text statt einer Antwort — dokumentiert in vercel/ai#13017. Der
 * Werkzeugmodus hebt es deshalb auf Gemini 2.5 Flash; die anderen Modelle
 * bleiben, wie der Plan sie vorgibt. Die Verbuchung in usage_events muss das
 * hier zurueckgegebene, tatsaechlich genutzte Modell nennen — nicht das des
 * Plans —, sonst stimmen die Kosten nicht.
 */
export function modellFuerWerkzeuge(modelId: string): string {
  return modelId === "google/gemini-2.5-flash-lite" ? "google/gemini-2.5-flash" : modelId;
}

/**
 * Kosten eines Aufrufs in Mikro-Dollar. Ganzzahlig, damit sich nichts
 * ueber Millionen von Zeilen aufsummierende Rundungsfehler einschleichen.
 *
 * Nimmt den Katalogeintrag entgegen, nicht die Kennung: Wer die Kennung hat,
 * loest sie ueber lib/modellkatalog.ts auf, und die Rechnung bleibt eine
 * reine Funktion.
 */
export function costInMicros(
  model: Pick<ModelInfo, "inputPerMillion" | "outputPerMillion" | "cacheReadPerMillion">,
  tokens: { input: number; output: number; cached: number },
): number {
  const uncachedInput = Math.max(tokens.input - tokens.cached, 0);

  const dollars =
    (uncachedInput * model.inputPerMillion) / 1_000_000 +
    (tokens.cached * model.cacheReadPerMillion) / 1_000_000 +
    (tokens.output * model.outputPerMillion) / 1_000_000;

  return Math.round(dollars * 1_000_000);
}
