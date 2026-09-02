import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { providerKeys, type ProviderKeyRow } from "./db/schema";
import type { KeyAnbieter } from "./models";

/**
 * Datenzugriff fuer die Tabelle provider_keys — und nichts weiter.
 *
 * Getrennt von lib/provider-keys.ts, damit die Logik dort (Verschluesseln,
 * Maskieren, Zwischenspeichern) in Tests gegen einen Speicher im Arbeitsspeicher
 * laufen kann, statt eine Drizzle-Kette nachzubauen.
 */

export async function ladeKeyZeile(provider: KeyAnbieter): Promise<ProviderKeyRow | null> {
  const zeile = await getDb().query.providerKeys.findFirst({
    where: eq(providerKeys.provider, provider),
  });
  return zeile ?? null;
}

export async function ladeKeyZeilen(): Promise<ProviderKeyRow[]> {
  return getDb().select().from(providerKeys);
}

export async function schreibeKeyZeile(zeile: {
  provider: KeyAnbieter;
  encrypted: string;
  masked: string;
}): Promise<void> {
  const werte = { encrypted: zeile.encrypted, masked: zeile.masked, updatedAt: new Date() };
  await getDb()
    .insert(providerKeys)
    .values({ provider: zeile.provider, ...werte })
    .onConflictDoUpdate({ target: providerKeys.provider, set: werte });
}

export async function loescheKeyZeile(provider: KeyAnbieter): Promise<void> {
  await getDb().delete(providerKeys).where(eq(providerKeys.provider, provider));
}
