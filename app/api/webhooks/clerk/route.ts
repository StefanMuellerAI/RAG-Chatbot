import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { seedStammdaten } from "@/lib/db/seed";
import { plans, users, webhookDeliveries } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Nutzerdaten von Clerk nach Postgres spiegeln.
 *
 * Die Route ist in proxy.ts als oeffentlich gefuehrt — Clerk stellt ohne
 * Sitzung zu. Die Echtheit haengt damit vollstaendig an der Svix-Signatur, die
 * `verifyWebhook` gegen CLERK_WEBHOOK_SIGNING_SECRET prueft. Ohne dieses
 * Geheimnis wirft die Funktion, und die Zustellung wird abgelehnt: ein
 * fehlendes Geheimnis darf nicht dazu fuehren, dass jeder Nutzerzeilen
 * anlegen kann.
 */
export async function POST(request: NextRequest) {
  let ereignis;
  try {
    ereignis = await verifyWebhook(request);
  } catch (error) {
    console.error("Clerk-Webhook: Signaturpruefung fehlgeschlagen.", error);
    return new Response("Signatur ungueltig.", { status: 400 });
  }

  // Svix wiederholt Zustellungen bei jedem Fehler und auch bei Zeitueberschreitung.
  // Die svix-id ist je Zustellung stabil und dient hier als Schluessel gegen
  // Doppelverarbeitung.
  const zustellungId = request.headers.get("svix-id");
  if (zustellungId && !(await erstmalig(zustellungId))) {
    return Response.json({ ok: true, wiederholung: true });
  }

  try {
    switch (ereignis.type) {
      case "user.created":
      case "user.updated":
        await nutzerSpeichern(ereignis.data);
        break;

      case "user.deleted":
        // Collections, Dokumente, Chats und Nachrichten haengen per
        // ON DELETE CASCADE an der Nutzerzeile und verschwinden mit ihr.
        // Was NICHT mitgeht, sind Blobs und Pinecone-Namespaces; die raeumt
        // der Aufraeumlauf ab (siehe lib/aufraeumen.ts).
        if (ereignis.data.id) await nutzerLoeschen(ereignis.data.id);
        break;

      default:
        break;
    }
  } catch (error) {
    // 500 zurueckgeben, damit Svix erneut zustellt: die Nutzerzeile ist die
    // Grundlage fuer alles Weitere und darf nicht fehlen.
    console.error(`Clerk-Webhook: ${ereignis.type} fehlgeschlagen.`, error);
    return new Response("Verarbeitung fehlgeschlagen.", { status: 500 });
  }

  return Response.json({ ok: true });
}

/** true, wenn diese Zustellung noch nicht verarbeitet wurde. */
async function erstmalig(zustellungId: string): Promise<boolean> {
  const eingefuegt = await getDb()
    .insert(webhookDeliveries)
    .values({ id: zustellungId })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });

  return eingefuegt.length > 0;
}

type ClerkNutzer = {
  id: string;
  email_addresses?: { id: string; email_address: string }[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

async function nutzerSpeichern(daten: ClerkNutzer): Promise<void> {
  const db = getDb();

  const email =
    daten.email_addresses?.find((eintrag) => eintrag.id === daten.primary_email_address_id)
      ?.email_address ??
    daten.email_addresses?.[0]?.email_address ??
    null;

  const name = [daten.first_name, daten.last_name].filter(Boolean).join(" ") || null;

  const standard = await standardplan();

  await db
    .insert(users)
    .values({ clerkUserId: daten.id, email, name, planId: standard })
    // Bei `user.updated` existiert die Zeile schon. Der Plan wird dabei
    // ausdruecklich NICHT angefasst: er ist eine Entscheidung des Admins und
    // hat in Clerk keine Entsprechung, die ihn ueberschreiben duerfte.
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email, name, updatedAt: new Date() },
    });
}

async function nutzerLoeschen(clerkUserId: string): Promise<void> {
  await getDb().delete(users).where(eq(users.clerkUserId, clerkUserId));
}

async function standardplan(): Promise<string> {
  const db = getDb();

  const vorhanden = await db.query.plans.findFirst({ where: eq(plans.isDefault, true) });
  if (vorhanden) return vorhanden.id;

  // Erste Registrierung in einer frischen Umgebung: Stammdaten fehlen noch.
  await seedStammdaten();
  const nachSeed = await db.query.plans.findFirst({ where: eq(plans.isDefault, true) });
  if (!nachSeed) throw new Error("Es ist kein Standardplan hinterlegt.");
  return nachSeed.id;
}
