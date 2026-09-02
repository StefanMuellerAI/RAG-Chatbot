import { eq } from "drizzle-orm";
import { MODELL_UMSTELLUNG, STANDARD_MODELLE } from "../models";
import { getDb } from "./index";
import { models, plans, sizeClasses } from "./schema";

/**
 * Stammdaten: die vier Groessenklassen, die vier Plaene und der Modellkatalog.
 *
 * Bewusst `onConflictDoNothing`: der Seed legt den Anfangszustand an, danach
 * gehoeren die Werte dem Admin. Ein erneuter Aufruf darf seine Anpassungen
 * nicht ueberschreiben — deshalb ist die Funktion beliebig oft aufrufbar.
 *
 * Aufgerufen wird sie an zwei Stellen: von `npm run db:seed` nach einem
 * Deployment (auch fuer Nachtraege wie MODELL_UMSTELLUNG) und aus
 * lib/auth/user.ts, wenn ein Nutzer auf eine Datenbank ohne Standardplan
 * trifft. Im Seitenrender hat sie nichts verloren — jeder Aufruf kostet
 * einen Datenbank-Roundtrip, auch wenn nichts zu tun ist.
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
    modelId: "google/gemini-2.5-flash-lite",
    isDefault: true,
  },
  {
    id: "M",
    label: "M",
    maxSizeClassId: "M",
    maxCollections: 10,
    maxQuestionsPerDay: 1_000,
    modelId: "google/gemini-2.5-flash-lite",
    isDefault: false,
  },
  {
    id: "L",
    label: "L",
    maxSizeClassId: "L",
    maxCollections: 25,
    maxQuestionsPerDay: 5_000,
    modelId: "google/gemini-2.5-flash",
    isDefault: false,
  },
  {
    id: "XL",
    label: "XL",
    maxSizeClassId: "XL",
    maxCollections: 100,
    maxQuestionsPerDay: 25_000,
    modelId: "openai/gpt-5-mini",
    isDefault: false,
  },
] as const;

export async function seedStammdaten(): Promise<void> {
  const db = getDb();

  // Bestehende Plaene behalten durch onConflictDoNothing ihre Modellkennung.
  // Anthropic ist im AI-Gateway-Free-Tier gesperrt — ohne diese Umstellung
  // wuerde der Chat weiter gegen Claude laufen und mit 403 scheitern.
  const umstellungen = Object.entries(MODELL_UMSTELLUNG).map(([alt, neu]) =>
    db
      .update(plans)
      .set({ modelId: neu, updatedAt: new Date() })
      .where(eq(plans.modelId, alt)),
  );

  // Ein Roundtrip statt sechs: `batch` schickt alles in einer Transaktion.
  // Die Reihenfolge bleibt wichtig — Groessenklassen zuerst, die Plaene
  // verweisen darauf. Der Modellkatalog beginnt mit den drei Modellen, mit
  // denen die Anwendung bisher fest lief; danach pflegt ihn der Admin, und
  // seine Preise und Aktiv-Marken bleiben durch onConflictDoNothing erhalten.
  await db.batch([
    db.insert(sizeClasses).values([...GROESSENKLASSEN]).onConflictDoNothing(),
    db.insert(plans).values([...PLAENE]).onConflictDoNothing(),
    db
      .insert(models)
      .values(
        STANDARD_MODELLE.map((modell) => ({
          id: modell.id,
          provider: modell.provider,
          label: modell.label,
          inputPerMillion: modell.inputPerMillion,
          outputPerMillion: modell.outputPerMillion,
          cacheReadPerMillion: modell.cacheReadPerMillion,
          enabled: modell.enabled,
          sortOrder: modell.sortOrder,
        })),
      )
      .onConflictDoNothing(),
    ...umstellungen,
  ]);
}
