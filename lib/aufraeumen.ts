import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { collections, documents, webhookDeliveries } from "./db/schema";
import { loescheDatei } from "./documents";

/**
 * Regelmaessiges Abraeumen.
 *
 * Drei Arten von Ueberresten entstehen im Betrieb unvermeidlich:
 *
 *   1. Angekuendigte Uploads, die nie ankamen. Der Metadatensatz entsteht vor
 *      der Datei, damit das Kontingent vorher geprueft werden kann — bricht der
 *      Browser danach ab, bleibt er stehen. Und weil er beim Anlegen den
 *      Dokumentzaehler erhoeht hat, verkleinert er das Kontingent des Nutzers,
 *      ohne dass etwas dafuer da waere.
 *   2. Verarbeitungen, die haengen geblieben sind. Ein Dokument auf "laeuft",
 *      dessen Ablauf nicht mehr existiert, wuerde die Fortschrittsanzeige
 *      dauerhaft in Bewegung halten.
 *   3. Verarbeitete Webhook-Zustellungen. Die Kennungen dienen nur der
 *      Doppelerkennung und sind nach wenigen Tagen wertlos.
 */

/** Nach dieser Zeit gilt ein angekuendigter Upload als gescheitert. */
const ANMELDUNG_VERFALL_MINUTEN = 60;

/**
 * Nach dieser Zeit gilt eine Verarbeitung als haengen geblieben.
 *
 * Grosszuegig bemessen: Ein Ablauf darf wiederholen, und ein Dokument mit
 * zweitausend Seiten braucht seine Zeit. Zu knapp gesetzt wuerde hier eine
 * laufende Verarbeitung fuer gescheitert erklaert.
 */
const VERARBEITUNG_VERFALL_MINUTEN = 90;

/** Nach dieser Zeit wiederholt Svix nicht mehr — die Kennung ist entbehrlich. */
const ZUSTELLUNG_VERFALL_TAGE = 7;

export type Aufraeumbericht = {
  verworfeneAnmeldungen: number;
  abgebrocheneVerarbeitungen: number;
  entfernteZustellungen: number;
};

export async function raeumeAuf(): Promise<Aufraeumbericht> {
  return {
    verworfeneAnmeldungen: await verwerfeAlteAnmeldungen(),
    abgebrocheneVerarbeitungen: await brecheHaengendeVerarbeitungenAb(),
    entfernteZustellungen: await entferneAlteZustellungen(),
  };
}

/**
 * Verwirft angekuendigte Uploads, die nie angekommen sind, und gibt das
 * Kontingent zurueck.
 */
async function verwerfeAlteAnmeldungen(): Promise<number> {
  const db = getDb();
  const grenze = vorMinuten(ANMELDUNG_VERFALL_MINUTEN);

  const verwaist = await db
    .select({
      id: documents.id,
      collectionId: documents.collectionId,
      blobPath: documents.blobPath,
    })
    .from(documents)
    .where(and(eq(documents.status, "wartet"), lt(documents.uploadedAt, grenze)))
    .limit(500);

  for (const satz of verwaist) {
    // Die Datei kann trotz "wartet" liegen, falls der Upload durchlief und nur
    // das Anstossen der Verarbeitung fehlschlug.
    await loescheDatei(satz.blobPath).catch(() => {});

    await db.delete(documents).where(eq(documents.id, satz.id));
    await db
      .update(collections)
      .set({
        documentCount: sql`greatest(${collections.documentCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, satz.collectionId));
  }

  return verwaist.length;
}

/**
 * Setzt haengende Verarbeitungen auf "fehler".
 *
 * Bewusst mit einer Meldung, die zum erneuten Versuch auffordert, statt still
 * aufzuraeumen: Der Nutzer hat eine Datei hochgeladen und soll erfahren, dass
 * daraus nichts geworden ist.
 */
async function brecheHaengendeVerarbeitungenAb(): Promise<number> {
  const abgebrochen = await getDb()
    .update(documents)
    .set({
      status: "fehler",
      error:
        "Die Verarbeitung wurde nicht abgeschlossen. Bitte ueber \"Erneut\" nochmals anstossen.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documents.status, "laeuft"),
        lt(documents.updatedAt, vorMinuten(VERARBEITUNG_VERFALL_MINUTEN)),
      ),
    )
    .returning({ id: documents.id });

  return abgebrochen.length;
}

async function entferneAlteZustellungen(): Promise<number> {
  const entfernt = await getDb()
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, vorMinuten(ZUSTELLUNG_VERFALL_TAGE * 24 * 60)))
    .returning({ id: webhookDeliveries.id });

  return entfernt.length;
}

function vorMinuten(minuten: number): Date {
  return new Date(Date.now() - minuten * 60 * 1000);
}
