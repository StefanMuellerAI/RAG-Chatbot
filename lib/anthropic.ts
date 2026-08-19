import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";
import type { Hit } from "./vector";

/** Erst im Request-Handler aufrufen, niemals auf Modulebene. */
export function getClient(): Anthropic {
  const env = requireEnv("ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export const MODEL = "claude-opus-5";

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
      return `[${i + 1}] Quelle: ${source}\n${hit.metadata.text}`;
    })
    .join("\n\n---\n\n");

  return `Auszuege aus der internen Dokumentensammlung:\n\n${excerpts}`;
}
