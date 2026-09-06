import { connection } from "next/server";
import NichtBereit from "@/components/NichtBereit";
import SammlungenBereich from "@/components/SammlungenBereich";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { erlaubteGroessenklassen, ladeSammlungen } from "@/lib/collections";
import { graphConfigured, missingFor } from "@/lib/env";
import { graphExtraktionKonfiguriert } from "@/lib/graph-extraktion";
import { starteMessung } from "@/lib/messung";
import { PRESETS } from "@/lib/presets";
import { rerankKonfiguriert } from "@/lib/rerank";

export const dynamic = "force-dynamic";

export default async function SammlungenSeite() {
  await connection();
  const messung = starteMessung("page_render", { route: "/sammlungen" });
  const fehlt = await missingFor("collections");
  if (fehlt.length > 0) {
    return <NichtBereit bereich="Die Dokumentenverwaltung" fehlt={fehlt} />;
  }
  messung.phase("env");

  const kontext = await requireKontextFuerSeite("/sammlungen");
  messung.phase("kontext");
  const [sammlungen, klassen] = await Promise.all([
    ladeSammlungen(kontext.userId),
    erlaubteGroessenklassen(kontext),
  ]);
  messung.phase("daten");
  messung.ende({ sammlungen: sammlungen.length });

  return (
    <SammlungenBereich
      sammlungen={sammlungen}
      klassen={klassen}
      presets={[...PRESETS]}
      graphVerfuegbar={graphConfigured()}
      graphExtraktionVerfuegbar={graphExtraktionKonfiguriert()}
      rerankVerfuegbar={rerankKonfiguriert()}
      plan={{
        label: kontext.plan.label,
        maxCollections: kontext.plan.maxCollections,
        maxSizeClassId: kontext.maxSizeClass.id,
      }}
    />
  );
}
