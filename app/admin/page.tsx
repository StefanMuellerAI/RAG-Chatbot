import AdminKonsole from "@/components/AdminKonsole";
import {
  ladeGroessenklassen,
  ladeNutzer,
  ladePlaene,
  ladeVerbrauch,
} from "@/lib/admin";
import { requireAdmin } from "@/lib/auth/user";
import { seedStammdaten } from "@/lib/db/seed";
import { missingFor } from "@/lib/env";
import { MODELS } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function AdminSeite({
  searchParams,
}: {
  searchParams: Promise<{ suche?: string; seite?: string }>;
}) {
  const fehlt = missingFor("admin");
  if (fehlt.length > 0) {
    return (
      <div className="meldung">
        <b>Die Administration ist noch nicht einsatzbereit.</b> Es fehlen folgende
        Environment-Variablen: <code>{fehlt.join(", ")}</code>.
      </div>
    );
  }

  try {
    await requireAdmin();
  } catch {
    return (
      <div className="meldung">
        <b>Kein Zugriff.</b> Dieser Bereich ist der Administration vorbehalten. Wenn Sie
        Administrationsrechte brauchen, muss eine Person, die sie bereits hat, sie Ihnen
        in der Nutzerliste erteilen.
      </div>
    );
  }

  // Idempotent. Faengt den Fall ab, dass die Datenbank frisch aufgesetzt wurde
  // und noch keine Groessenklassen existieren - dann waere die Oberflaeche leer
  // und nicht bedienbar, weil sich ein Plan ohne Groessenklasse nicht anlegen laesst.
  await seedStammdaten();

  const parameter = await searchParams;
  const suche = parameter.suche ?? "";
  const seite = Number(parameter.seite ?? "1");

  const [groessenklassen, plaene, nutzer, verbrauch] = await Promise.all([
    ladeGroessenklassen(),
    ladePlaene(),
    ladeNutzer(suche, Number.isFinite(seite) ? seite : 1),
    ladeVerbrauch(),
  ]);

  return (
    <AdminKonsole
      groessenklassen={groessenklassen}
      plaene={plaene}
      nutzer={nutzer}
      verbrauch={verbrauch}
      modelle={[...MODELS]}
      suche={suche}
    />
  );
}
