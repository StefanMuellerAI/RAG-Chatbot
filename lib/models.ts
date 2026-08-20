/**
 * Zugelassene Modelle und ihre Preise.
 *
 * Die Preise stehen hier, weil jede Antwort in usage_events mit ihren Kosten
 * verbucht wird. Ohne diese Zuordnung ist bei 15.000 Nutzern nicht
 * feststellbar, wer die Rechnung treibt.
 *
 * Der Plan eines Nutzers waehlt das Modell (plans.model_id). Dass hier drei
 * Modelle stehen und nicht eines, ist nicht nur eine Kostenfrage: Anthropic
 * zaehlt seine Minutenlimits GETRENNT PRO MODELL. Wer die Last auf Haiku,
 * Sonnet und Opus verteilt, hat damit das Dreifache an Durchsatz zur
 * Verfuegung — der entscheidende Hebel, um ueberhaupt in die Naehe von
 * 15.000 gleichzeitigen Nutzern zu kommen.
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
    id: "anthropic/claude-haiku-4.5",
    label: "Haiku 4.5 — schnell und guenstig",
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Sonnet 5 — ausgewogen",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Opus 5 — hoechste Qualitaet",
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
  },
] as const;

/** Fallback, falls ein Plan eine unbekannte Modellkennung traegt. */
export const DEFAULT_MODEL_ID = "anthropic/claude-haiku-4.5";

export function findModel(id: string): ModelInfo {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((model) => model.id === id);
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
