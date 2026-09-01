import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { KIND_LABEL } from "./collection-kinds";
import type { Collection } from "./collections";
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

/**
 * System-Prompt fuer den Werkzeugmodus: das Modell befragt Sammlungen selbst
 * (Suche, SQL, Cypher). `collections` ist die Liste, aus der es waehlen darf;
 * im Einzelmodus ist es genau eine.
 */
export function buildToolPrompt(collections: Collection[], einzelmodus: boolean): string {
  const liste = collections.map(describeCollection).join("\n\n");

  return `Du bist der Wissensassistent einer Organisation. Du beantwortest Fragen ausschliesslich auf Grundlage dessen, was du mit den bereitgestellten Werkzeugen aus den Sammlungen des Nutzers abrufst.

${einzelmodus ? "Es gibt genau eine Sammlung:" : "Verfuegbare Sammlungen (waehle selbst, welche zur Frage passen — auch mehrere):"}

${liste}

Regeln:
- Rufe zuerst Werkzeuge auf, dann antworte. Nutze kein Allgemeinwissen, um Luecken zu fuellen.
- Dokumentensammlungen: search_documents. Zitiere Auszuege mit ihrer Nummer in eckigen Klammern, z. B. [1] oder [2][3].
- Tabellen-Sammlungen: run_sql mit SQLite-Dialekt. Genau ein SELECT (auch WITH), ohne Semikolon. Aggregiere und filtere in SQL statt viele Zeilen zu lesen; nutze die Spaltennamen exakt wie angegeben (in doppelten Anfuehrungszeichen, falls noetig). Ergebnisse sind auf 200 Zeilen begrenzt — bei mehr Daten gruppieren oder LIMIT/ORDER BY einsetzen.
- Graph-Sammlungen: run_cypher mit openCypher (FalkorDB). Genau ein MATCH/RETURN-Statement, ohne Semikolon. Wenn du Kanten zaehlst, referenziere den Beziehungs-Alias in RETURN oder WHERE. Keine Aggregation innerhalb von Pattern-Comprehensions. Keine Schreiboperationen (CREATE, MERGE, SET, DELETE).
- Schlaegt eine Abfrage fehl, lies die Fehlermeldung, korrigiere die Abfrage und versuche es hoechstens zweimal erneut.
- Nenne in der Antwort, aus welcher Sammlung die Information stammt. Zahlen aus SQL/Cypher gibst du so wieder, wie sie zurueckkamen.
- Liefern die Werkzeuge nichts Passendes, sage das ausdruecklich. Rate nicht und formuliere nichts Plausibles hinzu.
- Antworte auf Deutsch, sachlich und so knapp wie moeglich. Nutze Absaetze oder Aufzaehlungen, wenn das die Antwort klarer macht.
- Fragen zur Bedienung des Assistenten selbst darfst du direkt beantworten, ohne Werkzeug.`;
}

function describeCollection(collection: Collection): string {
  const kopf = `### ${collection.name}\n- Typ: ${KIND_LABEL[collection.kind]}\n- collectionId: ${collection.id}`;
  const schema = collection.schema;

  if (collection.kind === "sql") {
    if (!schema || schema.kind !== "sql" || schema.tables.length === 0) return `${kopf}\n- Noch keine Tabellen.`;
    const tabellen = schema.tables
      .map((table) => {
        const spalten = table.columns
          .map((column) => {
            const beispiele = table.samples?.[column.name];
            return `${column.name} ${column.type}${beispiele && beispiele.length > 0 ? ` (z. B. ${beispiele.join(", ")})` : ""}`;
          })
          .join("; ");
        return `- Tabelle "${table.name}" (${table.rows.toLocaleString("de-DE")} Zeilen): ${spalten}`;
      })
      .join("\n");
    return `${kopf}\n${tabellen}`;
  }

  if (collection.kind === "graph") {
    if (!schema || schema.kind !== "graph" || schema.nodes === 0) return `${kopf}\n- Graph ist noch leer.`;
    return (
      `${kopf}\n- ${schema.nodes.toLocaleString("de-DE")} Knoten, ${schema.relationships.toLocaleString("de-DE")} Kanten` +
      `\n- Labels: ${schema.labels.join(", ") || "—"}` +
      `\n- Beziehungstypen: ${schema.relationshipTypes.join(", ") || "—"}` +
      `\n- Eigenschaften: ${schema.propertyKeys.join(", ") || "—"}`
    );
  }

  return `${kopf}\n- Dokumente mit semantischer Suche (search_documents).`;
}

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
