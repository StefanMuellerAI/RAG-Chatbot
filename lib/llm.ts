import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { PROVIDER_LABEL, type Provider } from "./providers";
import type { Hit } from "./vector";

/**
 * Anbindung der Modellanbieter ueber das AI SDK. Der Key kommt aus den
 * Admin-Einstellungen und wird pro Aufruf uebergeben — es gibt keinen
 * Client auf Modulebene.
 */

export type ModelTarget = { provider: Provider; model: string; apiKey: string };

/**
 * Denkaufwand fuer die Antwortgenerierung — anbieterneutral, das SDK
 * uebersetzt es in effort bzw. reasoningEffort. Der Chat soll zuegig
 * antworten, nicht maximal gruebeln.
 */
export const REASONING = "medium" as const;

export function getModel({ provider, model, apiKey }: ModelTarget): LanguageModel {
  return provider === "anthropic"
    ? createAnthropic({ apiKey })(model)
    : createOpenAI({ apiKey })(model);
}

/**
 * Kleinstmoeglicher Aufruf, um Key und Modell-ID zu pruefen — mit denselben
 * Parametern wie der Chat, damit der Test aussagekraeftig ist.
 */
export async function testModel(target: ModelTarget): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await generateText({
      model: getModel(target),
      prompt: "Antworte nur mit OK.",
      maxOutputTokens: 64,
      reasoning: REASONING,
      maxRetries: 0,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeProviderError(error, target.provider) };
  }
}

/** Uebersetzt SDK-/HTTP-Fehler in einen Satz, mit dem der Admin etwas anfangen kann. */
export function describeProviderError(error: unknown, provider: Provider): string {
  const label = PROVIDER_LABEL[provider];
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) return `${label} hat den API-Key abgelehnt.`;
  if (status === 404) return `${label} kennt dieses Modell nicht. Bitte die Modell-ID pruefen.`;
  if (status === 429) return `${label} meldet ein Ratenlimit oder erschoepftes Guthaben.`;
  return `${label}: ${message}`;
}

export const SYSTEM_PROMPT = `Du bist der Wissensassistent einer Organisation. Du beantwortest Fragen ausschliesslich auf Grundlage der Auszuege, die dir zu jeder Frage aus der internen Dokumentensammlung mitgeliefert werden.

Regeln:
- Stuetze jede inhaltliche Aussage auf die Auszuege. Nutze kein Allgemeinwissen, um Luecken zu fuellen.
- Belege jede Aussage mit der Nummer des Auszugs in eckigen Klammern, zum Beispiel [1] oder [2][3].
- Wenn die Auszuege die Frage nicht oder nur teilweise beantworten, sage das ausdruecklich. Rate nicht und formuliere nichts Plausibles hinzu.
- Widersprechen sich Auszuege, benenne den Widerspruch, statt dich fuer eine Seite zu entscheiden.
- Antworte auf Deutsch, sachlich und so knapp wie moeglich. Nutze Absaetze oder Aufzaehlungen, wenn das die Antwort klarer macht.
- Fragen zur Bedienung des Assistenten selbst darfst du direkt beantworten, ohne Beleg.`;

/** Baut den Kontextblock, der der Frage vorangestellt wird. */
export function buildContext(hits: Hit[]): string {
  const excerpts = hits
    .map((hit, i) => {
      const source = hit.metadata.location
        ? `${hit.metadata.filename}, ${hit.metadata.location}`
        : hit.metadata.filename;
      return `[${i + 1}] Quelle: ${source}\n${hit.text}`;
    })
    .join("\n\n---\n\n");

  return `Auszuege aus der internen Dokumentensammlung:\n\n${excerpts}`;
}
