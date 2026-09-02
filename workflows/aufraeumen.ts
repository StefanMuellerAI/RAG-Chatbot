import { RetryableError } from "workflow";
import type { CollectionKind } from "@/lib/collection-kinds";
import { loescheUnterPraefix, nutzerPraefix } from "@/lib/documents";
import { fehlerMeldung } from "@/lib/errors";
import { deleteGraph } from "@/lib/graphstore";
import { loescheSammlung } from "@/lib/vector";

/**
 * Raeumt die Spuren eines geloeschten Nutzers ab.
 *
 * Die Zeilen in Postgres verschwinden per ON DELETE CASCADE mit der
 * Nutzerzeile. Was NICHT mitgeht, sind drei Dinge ausserhalb der Datenbank:
 * die Namespaces in Pinecone, die Graphen in FalkorDB und die Dateien im
 * Blob-Store. Alles davon wuerde unbemerkt weiter Kosten verursachen und —
 * schwerer wiegend — personenbezogene Unterlagen aufbewahren, deren Grundlage
 * entfallen ist.
 *
 * Die SQLite-Dateien der Tabellen-Sammlungen liegen im Nutzerpraefix und
 * gehen mit den Dateien mit; sie brauchen keinen eigenen Schritt.
 *
 * Als Ablauf und nicht im Webhook, weil ein Nutzer mit hundert Sammlungen
 * hundert Loeschvorgaenge nach sich zieht. Der Webhook muss zuegig antworten,
 * sonst stellt Svix erneut zu.
 */

/** Was der Webhook vor dem Loeschen der Nutzerzeile noch lesen konnte. */
export type SammlungZumAbraeumen = { id: string; kind: CollectionKind };

async function loescheNamespace(collectionId: string): Promise<void> {
  "use step";

  console.log(`[aufraeumen] Namespace der Sammlung ${collectionId}`);

  try {
    await loescheSammlung(collectionId);
  } catch (error) {
    const meldung = fehlerMeldung(error);
    // Ueberlast lohnt einen weiteren Versuch; alles andere waere eine Schleife.
    if (/429|ueberlastet|timeout|ECONNRESET/i.test(meldung)) {
      throw new RetryableError(meldung, { retryAfter: "1m" });
    }
    throw error;
  }
}

async function loescheGraph(collectionId: string): Promise<void> {
  "use step";

  console.log(`[aufraeumen] Graph der Sammlung ${collectionId}`);

  try {
    // Einen nie beschriebenen Graphen toleriert deleteGraph von selbst.
    await deleteGraph(collectionId);
  } catch (error) {
    const meldung = fehlerMeldung(error);
    if (/Verbindung|timeout|ECONNRESET|ECONNREFUSED/i.test(meldung)) {
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
  sammlungen: SammlungZumAbraeumen[],
): Promise<void> {
  "use workflow";

  // Der Reihe nach und nicht parallel: Ein Nutzer mit vielen Sammlungen wuerde
  // sonst hundert gleichzeitige Loeschvorgaenge ausloesen und selbst die
  // Ratenbegrenzung des Vektor-Anbieters reissen.
  for (const sammlung of sammlungen) {
    if (sammlung.kind === "graph") {
      await loescheGraph(sammlung.id);
    } else if (sammlung.kind === "vector") {
      await loescheNamespace(sammlung.id);
    }
  }

  // Zuletzt die Dateien: Sie liegen alle unter einem Praefix und gehen in einem
  // Durchgang.
  await loescheDateien(userId);
}
