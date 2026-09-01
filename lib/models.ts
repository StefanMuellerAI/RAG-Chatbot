import { PROVIDER_LABEL, type ModelInfo, type Provider } from "./providers";

/**
 * Modell-Listen direkt vom Anbieter. Eine fest einprogrammierte Liste waere
 * nach wenigen Monaten veraltet — der Kunde soll sehen, was sein Konto
 * tatsaechlich freigeschaltet hat.
 */

/** Modelle, die im OpenAI-Katalog stehen, aber keinen Chat fuehren koennen. */
const OPENAI_EXCLUDE =
  /realtime|audio|tts|transcribe|whisper|image|dall-e|embedding|search|moderation|instruct|babbage|davinci|computer-use|sora/i;

export async function listModels(provider: Provider, apiKey: string): Promise<ModelInfo[]> {
  return provider === "anthropic" ? listAnthropic(apiKey) : listOpenAI(apiKey);
}

async function listAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  const body = await parse<{ data?: { id: string; display_name?: string; created_at?: string }[] }>(
    response,
    "anthropic",
  );

  return (body.data ?? [])
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((model) => ({ id: model.id, label: model.display_name ?? model.id }));
}

async function listOpenAI(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await parse<{ data?: { id: string; created?: number }[] }>(response, "openai");

  return (body.data ?? [])
    .filter((model) => /^(gpt-|o\d)/.test(model.id) && !OPENAI_EXCLUDE.test(model.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((model) => ({ id: model.id, label: model.id }));
}

async function parse<T>(response: Response, provider: Provider): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  const label = PROVIDER_LABEL[provider];
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} hat den API-Key abgelehnt. Bitte den Key pruefen.`);
  }

  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    detail = typeof body.error === "string" ? body.error : body.error?.message ?? "";
  } catch {
    // Kein JSON — die Statusmeldung reicht.
  }
  throw new Error(
    `${label} antwortete mit Status ${response.status}${detail ? `: ${detail}` : "."}`,
  );
}
