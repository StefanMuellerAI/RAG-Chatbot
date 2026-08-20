import SammlungenBereich from "@/components/SammlungenBereich";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { erlaubteGroessenklassen, ladeSammlungen } from "@/lib/collections";
import { missingFor } from "@/lib/env";
import { PRESETS } from "@/lib/presets";

export const dynamic = "force-dynamic";

export default async function SammlungenSeite() {
  const fehlt = missingFor("collections");
  if (fehlt.length > 0) {
    return (
      <div className="meldung">
        <b>Die Dokumentenverwaltung ist noch nicht einsatzbereit.</b> Es fehlen folgende
        Environment-Variablen: <code>{fehlt.join(", ")}</code>.
      </div>
    );
  }

  const kontext = await requireKontextFuerSeite("/sammlungen");
  const [sammlungen, klassen] = await Promise.all([
    ladeSammlungen(kontext.userId),
    erlaubteGroessenklassen(kontext),
  ]);

  return (
    <SammlungenBereich
      sammlungen={sammlungen}
      klassen={klassen}
      presets={[...PRESETS]}
      plan={{
        label: kontext.plan.label,
        maxCollections: kontext.plan.maxCollections,
        maxSizeClassId: kontext.maxSizeClass.id,
      }}
    />
  );
}
