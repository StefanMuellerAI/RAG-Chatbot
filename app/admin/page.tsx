import { connection } from "next/server";
import AdminKonsole from "@/components/AdminKonsole";
import NichtBereit from "@/components/NichtBereit";
import {
  ladeGroessenklassen,
  ladeModellKatalog,
  ladeNutzer,
  ladePlaene,
  ladeVerbrauch,
} from "@/lib/admin";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { seedStammdaten } from "@/lib/db/seed";
import { ladeEinladungen } from "@/lib/einladungen";
import { missingFor, providerKeySecretKonfiguriert } from "@/lib/env";
import { ladeKeyStatus } from "@/lib/provider-keys";

export const dynamic = "force-dynamic";

export default async function AdminSeite({
  searchParams,
}: {
  searchParams: Promise<{ suche?: string; seite?: string }>;
}) {
  await connection();
  const fehlt = await missingFor("admin");
  if (fehlt.length > 0) return <NichtBereit bereich="Die Administration" fehlt={fehlt} />;

  // Zur Anmeldung, wenn niemand angemeldet ist. Ist jemand angemeldet, hat aber
  // die Rolle nicht, bleibt es bei einer Erklaerung statt einer Weiterleitung -
  // sonst laufe er im Kreis, denn erneutes Anmelden aendert daran nichts.
  const kontext = await requireKontextFuerSeite("/admin");

  if (!kontext.isAdmin) {
    return (
      <div className="meldung">
        <b>Kein Zugriff.</b> Dieser Bereich ist der Administration vorbehalten. Wenn Sie
        Administrationsrechte brauchen, muss eine Person, die sie bereits hat, sie Ihnen in
        der Nutzerliste erteilen.
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

  const secretKonfiguriert = providerKeySecretKonfiguriert();

  const [groessenklassen, plaene, nutzer, verbrauch, katalog, keyStatus, einladungen] =
    await Promise.all([
      ladeGroessenklassen(),
      ladePlaene(),
      ladeNutzer(suche, Number.isFinite(seite) ? seite : 1),
      ladeVerbrauch(),
      ladeModellKatalog(),
      // Ohne PROVIDER_KEY_SECRET liesse sich kein Chiffrat pruefen; die Karte
      // zeigt dann den Hinweis statt eines Fehlers.
      secretKonfiguriert ? ladeKeyStatus() : Promise.resolve({}),
      // Die Einladungen kommen von Clerk, nicht aus Postgres. Ist Clerk gerade
      // nicht erreichbar, soll der Rest der Konsole trotzdem bedienbar bleiben.
      ladeEinladungen().catch((error: unknown) => {
        console.error("Einladungen konnten nicht geladen werden.", error);
        return null;
      }),
    ]);

  return (
    <AdminKonsole
      groessenklassen={groessenklassen}
      plaene={plaene}
      nutzer={nutzer}
      verbrauch={verbrauch}
      // Direkt aus dem frisch geladenen Katalog, nicht aus dem Zwischenspeicher:
      // Der Admin soll seine Aenderung sofort im Auswahlfeld sehen.
      modelle={katalog.filter((eintrag) => eintrag.enabled)}
      katalog={katalog}
      keyStatus={keyStatus}
      secretKonfiguriert={secretKonfiguriert}
      einladungen={einladungen}
      suche={suche}
    />
  );
}
