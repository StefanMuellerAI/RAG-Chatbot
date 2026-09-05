import { createHash } from "node:crypto";
import { getDb } from "./db";
import { usageEvents } from "./db/schema";
import { findeModell } from "./modellkatalog";
import { costInMicros } from "./models";

/**
 * Verbrauchsjournal.
 *
 * Getrennt von der Kontingentpruefung in lib/ratelimit.ts, und zwar bewusst:
 * Die Pruefung muss schnell und vor der Antwort passieren, die Verbuchung
 * braucht die tatsaechlichen Tokenzahlen und kann erst danach erfolgen. Die
 * Zaehler in Redis steuern, diese Tabelle rechnet ab.
 */

/** Tokenzahlen, wie sie das AI SDK nach einem Aufruf liefert. */
type Tokenverbrauch = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
};

export async function verbucheFrage(
  userId: string,
  modelId: string,
  verbrauch: Tokenverbrauch | undefined,
): Promise<void> {
  const input = verbrauch?.inputTokens ?? 0;
  const output = verbrauch?.outputTokens ?? 0;
  const gecacht = verbrauch?.inputTokenDetails?.cacheReadTokens ?? 0;

  try {
    // Preise aus dem Katalog zum Zeitpunkt der Antwort. Eine unbekannte
    // Kennung wird zum Preis des Standardmodells verbucht — so wie vorher.
    const modell = await findeModell(modelId);

    await getDb().insert(usageEvents).values({
      userId,
      day: new Date().toISOString().slice(0, 10),
      kind: "frage",
      model: modelId,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: gecacht,
      costMicros: costInMicros(modell, { input, output, cached: gecacht }),
    });
  } catch (error) {
    // Eine misslungene Verbuchung darf die bereits gelieferte Antwort nicht
    // nachtraeglich zum Fehler machen. Sie gehoert aber ins Log, denn ohne diese
    // Zeilen fehlt der Admin-Auswertung die Grundlage.
    console.error("Verbrauch konnte nicht verbucht werden.", error);
  }
}

/** Verbucht die Verarbeitung eines Dokuments — Kosten fallen dabei nicht an. */
export async function verbucheIngestion(
  userId: string,
  abschnitte: number,
  idempotencyKey?: string,
): Promise<void> {
  try {
    await getDb().insert(usageEvents).values({
      ...(idempotencyKey !== undefined ? { id: ingestionEventId(userId, idempotencyKey) } : {}),
      userId,
      day: new Date().toISOString().slice(0, 10),
      kind: "ingestion",
      // Die Abschnittszahl steht als Eingabemenge; das Einbetten laeuft beim
      // Vektor-Anbieter und nicht ueber das Modellbudget.
      inputTokens: abschnitte,
    }).onConflictDoNothing({ target: usageEvents.id });
  } catch (error) {
    console.error("Ingestion konnte nicht verbucht werden.", error);
  }
}

/** UUIDv8 derived from tenant and stable workflow step ID; retries share a row. */
function ingestionEventId(userId: string, key: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["ingestion", userId, key])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
