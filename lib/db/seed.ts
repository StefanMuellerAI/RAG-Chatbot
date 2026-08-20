import { getDb } from "./index";
import { plans, sizeClasses } from "./schema";

/**
 * Stammdaten: die vier Groessenklassen und die vier Plaene.
 *
 * Bewusst `onConflictDoNothing`: der Seed legt den Anfangszustand an, danach
 * gehoeren die Werte dem Admin. Ein erneuter Aufruf darf seine Anpassungen
 * nicht ueberschreiben — deshalb ist die Funktion beliebig oft aufrufbar und
 * wird auch beim ersten Oeffnen des Admin-Bereichs ausgefuehrt.
 */

const MB = 1024 * 1024;

/**
 * S entspricht der Vorgabe: 20 Dokumente à 100 Seiten. Die Gesamtseitenzahl
 * liegt bewusst genau auf dem Produkt, damit die Grenze verstaendlich bleibt.
 * M, L und XL sind Vorschlaege und im Admin-Bereich frei aenderbar.
 */
const GROESSENKLASSEN = [
  {
    id: "S",
    label: "S — kleine Sammlung",
    rank: 1,
    maxDocuments: 20,
    maxPagesPerDocument: 100,
    maxTotalPages: 2_000,
    maxFileBytes: 25 * MB,
  },
  {
    id: "M",
    label: "M — Abteilungssammlung",
    rank: 2,
    maxDocuments: 100,
    maxPagesPerDocument: 300,
    maxTotalPages: 20_000,
    maxFileBytes: 50 * MB,
  },
  {
    id: "L",
    label: "L — Hausarchiv",
    rank: 3,
    maxDocuments: 500,
    maxPagesPerDocument: 1_000,
    maxTotalPages: 150_000,
    maxFileBytes: 100 * MB,
  },
  {
    id: "XL",
    label: "XL — Grossbestand",
    rank: 4,
    maxDocuments: 2_000,
    maxPagesPerDocument: 2_000,
    maxTotalPages: 600_000,
    maxFileBytes: 200 * MB,
  },
] as const;

/**
 * Die Plaene heissen wie die hoechste Groessenklasse, die sie freischalten.
 * Ein Nutzer auf Plan "L" darf also S-, M- und L-Collections anlegen.
 * Neue Registrierungen erhalten S.
 */
const PLAENE = [
  {
    id: "S",
    label: "S",
    maxSizeClassId: "S",
    maxCollections: 3,
    maxQuestionsPerDay: 200,
    modelId: "anthropic/claude-haiku-4.5",
    isDefault: true,
  },
  {
    id: "M",
    label: "M",
    maxSizeClassId: "M",
    maxCollections: 10,
    maxQuestionsPerDay: 1_000,
    modelId: "anthropic/claude-haiku-4.5",
    isDefault: false,
  },
  {
    id: "L",
    label: "L",
    maxSizeClassId: "L",
    maxCollections: 25,
    maxQuestionsPerDay: 5_000,
    modelId: "anthropic/claude-sonnet-5",
    isDefault: false,
  },
  {
    id: "XL",
    label: "XL",
    maxSizeClassId: "XL",
    maxCollections: 100,
    maxQuestionsPerDay: 25_000,
    modelId: "anthropic/claude-opus-5",
    isDefault: false,
  },
] as const;

export async function seedStammdaten(): Promise<void> {
  const db = getDb();

  // Groessenklassen zuerst: die Plaene verweisen darauf.
  await db.insert(sizeClasses).values([...GROESSENKLASSEN]).onConflictDoNothing();
  await db.insert(plans).values([...PLAENE]).onConflictDoNothing();
}
