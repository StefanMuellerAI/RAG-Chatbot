import { notFound } from "next/navigation";
import SammlungDetail from "@/components/SammlungDetail";
import { requireKontext } from "@/lib/auth/user";
import { ladeSammlung } from "@/lib/collections";
import { ladeDokumenteDerSammlung } from "@/lib/documents";
import { NotFoundError } from "@/lib/errors";
import { findPreset } from "@/lib/presets";

export const dynamic = "force-dynamic";

export default async function SammlungSeite({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const kontext = await requireKontext();
  const { id } = await params;

  const daten = await lade(kontext.userId, id);
  // Eine fremde oder erfundene ID fuehrt zur gleichen Seite: Wer raet, soll
  // nicht daran erkennen koennen, dass die Sammlung existiert.
  if (!daten) notFound();

  return (
    <SammlungDetail
      sammlung={daten.sammlung}
      dokumente={daten.dokumente}
      preset={findPreset(daten.sammlung.preset)}
    />
  );
}

/**
 * Getrennt von der Darstellung, damit kein JSX im try-Block steht: React
 * rendert Komponenten nicht sofort, ein Fehler beim Rendern liefe also am
 * catch vorbei und der Block waere truegerisch.
 */
async function lade(userId: string, collectionId: string) {
  try {
    const [sammlung, dokumente] = await Promise.all([
      ladeSammlung(userId, collectionId),
      ladeDokumenteDerSammlung(userId, collectionId),
    ]);
    return { sammlung, dokumente };
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}
