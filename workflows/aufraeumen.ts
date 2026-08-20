import { RetryableError } from "workflow";
import { loescheUnterPraefix, nutzerPraefix } from "@/lib/documents";
import { loescheSammlung } from "@/lib/vector";

/**
 * Raeumt die Spuren eines geloeschten Nutzers ab.
 *
 * Die Zeilen in Postgres verschwinden per ON DELETE CASCADE mit der
 * Nutzerzeile. Was NICHT mitgeht, sind zwei Dinge ausserhalb der Datenbank:
 * die Namespaces in Pinecone und die Dateien im Blob-Store. Beides wuerde
 * unbemerkt weiter Kosten verursachen und — schwerer wiegend — personenbezogene
 * Unterlagen aufbewahren, deren Grundlage entfallen ist.
 *
 * Als Ablauf und nicht im Webhook, weil ein Nutzer mit hundert Sammlungen
 * hundert Loeschvorgaenge nach sich zieht. Der Webhook muss zuegig antworten,
 * sonst stellt Svix erneut zu.
 */

async function loescheNamespace(collectionId: string): Promise<void> {
  "use step";

  console.log(`[aufraeumen] Namespace der Sammlung ${collectionId}`);

  try {
    await loescheSammlung(collectionId);
  } catch (error) {
    const meldung = error instanceof Error ? error.message : String(error);
    // Ueberlast lohnt einen weiteren Versuch; alles andere waere eine Schleife.
    if (/429|ueberlastet|timeout|ECONNRESET/i.test(meldung)) {
      throw new RetryableError(meldung, { retryAfter: "1m" });
    }
    throw error;
  }
}

async function loescheDateien(userId: string): Promise<number> {
  "use step";

  const entfernt = await loescheUnterPraefix(nutzerPraefix(userId));
  console.log(`[aufraeumen] ${entfernt} Dateien von Nutzer ${userId} entfernt`);
  return entfernt;
}

export async function raeumeNutzerAb(
  userId: string,
  collectionIds: string[],
): Promise<void> {
  "use workflow";

  // Der Reihe nach und nicht parallel: Ein Nutzer mit vielen Sammlungen wuerde
  // sonst hundert gleichzeitige Loeschvorgaenge ausloesen und selbst die
  // Ratenbegrenzung des Vektor-Anbieters reissen.
  for (const collectionId of collectionIds) {
    await loescheNamespace(collectionId);
  }

  // Zuletzt die Dateien: Sie liegen alle unter einem Praefix und gehen in einem
  // Durchgang.
  await loescheDateien(userId);
}
