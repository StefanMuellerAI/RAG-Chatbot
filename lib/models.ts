/**
 * Zugelassene Modelle und ihre Preise.
 *
 * Die Preise stehen hier, weil jede Antwort in usage_events mit ihren Kosten
 * verbucht wird. Ohne diese Zuordnung ist bei 15.000 Nutzern nicht
 * feststellbar, wer die Rechnung treibt.
 *
 * Der Plan eines Nutzers waehlt das Modell (plans.model_id). Die drei Stufen
 * sind Modelle, die das AI Gateway im Free-Tier zulaesst: Anthropic (Haiku,
 * Sonnet, Opus) ist dort gesperrt. Getestet gegen denselben Account:
 * Gemini 2.5 Flash Lite / Flash und GPT-5 mini antworten, Claude nicht.
 *
 * Preise in US-Dollar je 1 Mio. Token, Stand August 2026. Cache-Treffer kosten
 * ein Zehntel des Eingabepreises.
 */

export type ModelInfo = {
  id: string;
  label: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
};

export const MODELS: readonly ModelInfo[] = [
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite — schnell und guenstig",
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.01,
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash — ausgewogen",
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.03,
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 mini — hoehere Qualitaet",
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.025,
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

export function findModel(id: string): ModelInfo {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((model) => model.id === id);
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
 */
export function costInMicros(
  modelId: string,
  tokens: { input: number; output: number; cached: number },
): number {
  const model = findModel(modelId);
  const uncachedInput = Math.max(tokens.input - tokens.cached, 0);

  const dollars =
    (uncachedInput * model.inputPerMillion) / 1_000_000 +
    (tokens.cached * model.cacheReadPerMillion) / 1_000_000 +
    (tokens.output * model.outputPerMillion) / 1_000_000;

  return Math.round(dollars * 1_000_000);
}
