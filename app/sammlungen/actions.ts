"use server";

import { alsAktion, type AktionsErgebnis } from "@/lib/aktionen";
import { getKontext, NotSignedInError } from "@/lib/auth/user";
import {
  aktualisiereSammlung,
  erstelleSammlung,
  type SammlungEingabe,
} from "@/lib/collections";

/**
 * Server Actions der Sammlungsverwaltung: Anlegen sowie Name und Beschreibung
 * aendern. Beides sind kurze Schreibvorgaenge, deren Ergebnis sofort auf der
 * Seite stehen soll — dafuer ist ein Roundtrip mit Neu-Rendern das Richtige.
 *
 * Uploads und das Loeschen einer Sammlung bleiben API-Routen: Sie dauern lang,
 * laufen ueber Blob und Workflows und melden Fortschritt statt eines Endstands.
 */

export async function erstelleSammlungAktion(
  eingabe: SammlungEingabe,
): Promise<AktionsErgebnis<{ id: string }>> {
  // Kontext vor dem Rahmen: das strukturierte Log zu Kontingentabweisungen
  // (409) braucht die Nutzerkennung.
  const kontext = await getKontext();
  return alsAktion(
    async () => {
      if (!kontext) throw new NotSignedInError();
      const sammlung = await erstelleSammlung(kontext, eingabe);
      return { id: sammlung.id };
    },
    { userId: kontext?.userId },
  );
}

export async function aktualisiereSammlungAktion(
  collectionId: string,
  eingabe: { name: unknown; beschreibung: unknown },
): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    const kontext = await getKontext();
    if (!kontext) throw new NotSignedInError();
    await aktualisiereSammlung(kontext.userId, collectionId, eingabe);
  });
}
