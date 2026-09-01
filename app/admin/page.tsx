import CollectionsOverview, { type SammlungZeile } from "@/components/CollectionsOverview";
import DangerZone from "@/components/DangerZone";
import SettingsCard from "@/components/SettingsCard";
import UsersCard, { type EinladungZeile, type NutzerZeile } from "@/components/UsersCard";
import { ADMIN_USER_ID } from "@/lib/auth";
import { listCollections } from "@/lib/collections";
import { listDocuments } from "@/lib/documents";
import { missingFor } from "@/lib/env";
import { listInvites } from "@/lib/invites";
import { DEFAULT_DAILY_ANSWER_LIMIT, type PublicSettings } from "@/lib/providers";
import { dailyUsage } from "@/lib/ratelimit";
import { getPublicSettings } from "@/lib/settings";
import { listUsers } from "@/lib/users";
import { vectorCount } from "@/lib/vector";

export const dynamic = "force-dynamic";

const LEERE_EINSTELLUNGEN: PublicSettings = {
  provider: "anthropic",
  model: "",
  keys: {},
  dailyAnswerLimit: DEFAULT_DAILY_ANSWER_LIMIT,
  dailyAnswerLimitPerUser: null,
  updatedAt: null,
};

export default async function AdminSeite() {
  const fehlt = missingFor("admin");

  let einstellungen = LEERE_EINSTELLUNGEN;
  let verbrauchHeute = 0;
  let vektoren: number | null = null;
  let nutzer: NutzerZeile[] = [];
  let einladungen: EinladungZeile[] = [];
  let sammlungen: SammlungZeile[] = [];
  const fehler: string[] = [];

  if (fehlt.length === 0) {
    const [einstellungenErgebnis, verbrauchErgebnis, vektorenErgebnis, nutzerErgebnis, einladungenErgebnis, sammlungenErgebnis] =
      await Promise.allSettled([
        getPublicSettings(),
        dailyUsage(),
        vectorCount(),
        listUsers(),
        listInvites(),
        ladeSammlungen(),
      ]);

    if (einstellungenErgebnis.status === "fulfilled") einstellungen = einstellungenErgebnis.value;
    else fehler.push(beschreibe(einstellungenErgebnis.reason, "Die Einstellungen konnten nicht geladen werden."));

    if (verbrauchErgebnis.status === "fulfilled") verbrauchHeute = verbrauchErgebnis.value;
    // Die Vektorzahl ist reine Anzeige — ein Fehler hier soll die Seite nicht stoeren.
    if (vektorenErgebnis.status === "fulfilled") vektoren = vektorenErgebnis.value;

    if (sammlungenErgebnis.status === "fulfilled") sammlungen = sammlungenErgebnis.value;
    else fehler.push(beschreibe(sammlungenErgebnis.reason, "Die Sammlungen konnten nicht geladen werden."));

    if (nutzerErgebnis.status === "fulfilled") {
      const anzahl = new Map<string, number>();
      for (const sammlung of sammlungen) anzahl.set(sammlung.ownerId, (anzahl.get(sammlung.ownerId) ?? 0) + 1);
      nutzer = nutzerErgebnis.value.map((user) => ({ ...user, collectionCount: anzahl.get(user.id) ?? 0 }));
      // E-Mail des Eigentuemers in die Sammlungsuebersicht eintragen.
      const emails = new Map(nutzerErgebnis.value.map((user) => [user.id, user.email]));
      emails.set(ADMIN_USER_ID, "Administrator");
      sammlungen = sammlungen.map((sammlung) => ({ ...sammlung, ownerEmail: emails.get(sammlung.ownerId) ?? sammlung.ownerId }));
    } else {
      fehler.push(beschreibe(nutzerErgebnis.reason, "Die Nutzerliste konnte nicht geladen werden."));
    }

    if (einladungenErgebnis.status === "fulfilled") einladungen = einladungenErgebnis.value;
    else fehler.push(beschreibe(einladungenErgebnis.reason, "Die Einladungen konnten nicht geladen werden."));
  }

  return (
    <>
      {fehlt.length > 0 && (
        <div className="meldung">
          <b>Die Verwaltung ist noch nicht einsatzbereit.</b> Es fehlen folgende
          Environment-Variablen: <code>{fehlt.join(", ")}</code>.
        </div>
      )}
      {fehler.map((text) => (
        <div key={text} className="meldung">
          {text}
        </div>
      ))}
      <SettingsCard einstellungen={einstellungen} verbrauchHeute={verbrauchHeute} />
      <UsersCard nutzer={nutzer} einladungen={einladungen} />
      <CollectionsOverview sammlungen={sammlungen} vektoren={vektoren} />
      <DangerZone />
    </>
  );
}

async function ladeSammlungen(): Promise<SammlungZeile[]> {
  const alle = await listCollections();
  return Promise.all(
    alle.map(async (collection) => {
      const documents = await listDocuments(collection.id);
      return {
        id: collection.id,
        name: collection.name,
        ownerId: collection.ownerId,
        ownerEmail: collection.ownerId,
        createdAt: collection.createdAt,
        documentCount: documents.length,
        chunkCount: documents.reduce((summe, document) => summe + document.chunkCount, 0),
      };
    }),
  );
}

function beschreibe(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
