import { asc } from "drizzle-orm";
import { getDb } from "./db";
import { models } from "./db/schema";
import {
  DEFAULT_MODEL_ID,
  STANDARD_MODELLE,
  standardModell,
  type ModelInfo,
} from "./models";
import { ausZwischenspeicher, verwirfZwischenspeicher } from "./ratelimit";

/**
 * Der Modellkatalog aus Postgres, fuer den Frageweg.
 *
 * Bei jeder Frage werden Preise und Anbindung des Modells gebraucht. Der
 * Katalog aendert sich aber nur, wenn ein Admin etwas eintraegt — deshalb
 * derselbe Zwischenspeicher wie fuer den Nutzerkontext: eine Minute in Redis,
 * ohne Redis frisch aus der Datenbank. Der Admin-Bereich liest nicht hierueber,
 * sondern direkt (lib/admin.ts), und verwirft den Zwischenspeicher nach jeder
 * Aenderung.
 */

const LEBENSDAUER_SEKUNDEN = 60;

export function modellSchluessel(): string {
  return "wa:modelle";
}

async function ladeAusDatenbank(): Promise<ModelInfo[]> {
  const zeilen = await getDb()
    .select({
      id: models.id,
      provider: models.provider,
      label: models.label,
      inputPerMillion: models.inputPerMillion,
      outputPerMillion: models.outputPerMillion,
      cacheReadPerMillion: models.cacheReadPerMillion,
      enabled: models.enabled,
      sortOrder: models.sortOrder,
    })
    .from(models)
    .orderBy(asc(models.sortOrder), asc(models.id));

  // Ein leerer Katalog (Migration eingespielt, Seed noch nicht gelaufen) darf
  // den Chat nicht lahmlegen: dann gilt der Standardkatalog.
  return zeilen.length > 0 ? zeilen : [...STANDARD_MODELLE];
}

/** Alle Katalogeintraege, aktive wie inaktive. */
export async function ladeModelle(): Promise<ModelInfo[]> {
  return ausZwischenspeicher(modellSchluessel(), LEBENSDAUER_SEKUNDEN, ladeAusDatenbank);
}

/** Nur die aktiven — das ist die Auswahl, die ein Plan bekommen darf. */
export async function ladeAktiveModelle(): Promise<ModelInfo[]> {
  return (await ladeModelle()).filter((modell) => modell.enabled);
}

/** Katalogeintrag zu einer Kennung, oder undefined, wenn es ihn nicht gibt. */
export async function sucheModell(id: string): Promise<ModelInfo | undefined> {
  return (await ladeModelle()).find((modell) => modell.id === id);
}

/**
 * Katalogeintrag zu einer Kennung — mit Rueckfall.
 *
 * Traegt ein Plan eine Kennung, die es im Katalog nicht (mehr) gibt, gilt das
 * Standardmodell: erst dessen Katalogeintrag, sonst der Eintrag aus dem
 * Standardkatalog in lib/models.ts. Der Chat bleibt damit auch dann
 * benutzbar, wenn ein Admin ein Modell entfernt hat.
 */
export async function findeModell(id: string): Promise<ModelInfo> {
  const katalog = await ladeModelle();
  return (
    katalog.find((modell) => modell.id === id) ??
    katalog.find((modell) => modell.id === DEFAULT_MODEL_ID) ??
    standardModell(id)
  );
}

/** Nach jeder Aenderung im Admin-Bereich, damit sie sofort greift. */
export async function verwirfModellkatalog(): Promise<void> {
  await verwirfZwischenspeicher(modellSchluessel());
}
