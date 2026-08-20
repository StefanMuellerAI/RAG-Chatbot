import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "../db";
import { seedStammdaten } from "../db/seed";
import { plans, sizeClasses, users } from "../db/schema";
import type { Plan, SizeClass } from "../db/schema";

/**
 * Bruecke zwischen Clerk und der eigenen Datenbank.
 *
 * Clerk haelt die Identitaet, Postgres haelt alles, was die Anwendung darueber
 * hinaus wissen muss: Plan, Adminrolle, Kontingente. Die Clerk-ID ist dabei
 * der Primaerschluessel — es gibt keine zweite Nutzerkennung und damit auch
 * keinen Abgleich, der auseinanderlaufen koennte.
 */

export class NotSignedInError extends Error {
  constructor() {
    super("Nicht angemeldet.");
    this.name = "NotSignedInError";
  }
}

export class NotAdminError extends Error {
  constructor() {
    super("Dieser Bereich ist der Administration vorbehalten.");
    this.name = "NotAdminError";
  }
}

/** Nutzer samt aufgeloestem Plan und dessen hoechster Groessenklasse. */
export type Kontext = {
  userId: string;
  isAdmin: boolean;
  plan: Plan;
  maxSizeClass: SizeClass;
};

/**
 * Legt die Nutzerzeile an, falls sie fehlt.
 *
 * Der regulaere Weg ist der Clerk-Webhook. Der kann aber verzoegert
 * eintreffen oder in einer frischen Umgebung noch nicht eingerichtet sein.
 * Deshalb wird hier notfalls nachgezogen: die Anwendung soll unmittelbar nach
 * dem ersten Deployment funktionieren, ohne dass zuerst ein Webhook
 * konfiguriert werden muss.
 */
async function anlegenFallsNoetig(clerkUserId: string): Promise<Kontext> {
  const db = getDb();

  const standard = await db.query.plans.findFirst({ where: eq(plans.isDefault, true) });

  // Leere Datenbank: Stammdaten sind noch nicht eingespielt.
  if (!standard) {
    await seedStammdaten();
    const nachSeed = await db.query.plans.findFirst({ where: eq(plans.isDefault, true) });
    if (!nachSeed) {
      throw new Error(
        "Es ist kein Standardplan hinterlegt. Bitte im Admin-Bereich einen Plan als Standard markieren.",
      );
    }
    return anlegen(clerkUserId, nachSeed);
  }

  return anlegen(clerkUserId, standard);
}

async function anlegen(clerkUserId: string, plan: Plan): Promise<Kontext> {
  const db = getDb();
  const clerk = await currentUser().catch(() => null);

  await db
    .insert(users)
    .values({
      clerkUserId,
      email: clerk?.primaryEmailAddress?.emailAddress ?? null,
      name: [clerk?.firstName, clerk?.lastName].filter(Boolean).join(" ") || null,
      planId: plan.id,
    })
    // Zwei gleichzeitige Anfragen desselben neuen Nutzers duerfen sich nicht
    // gegenseitig mit einem Schluesselkonflikt abschiessen.
    .onConflictDoNothing();

  const gelesen = await ladeKontext(clerkUserId);
  if (!gelesen) throw new Error("Der Nutzer konnte nicht angelegt werden.");
  return gelesen;
}

async function ladeKontext(clerkUserId: string): Promise<Kontext | null> {
  const db = getDb();

  const [zeile] = await db
    .select({
      userId: users.clerkUserId,
      isAdmin: users.isAdmin,
      plan: plans,
      maxSizeClass: sizeClasses,
    })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .innerJoin(sizeClasses, eq(plans.maxSizeClassId, sizeClasses.id))
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  return zeile ?? null;
}

/**
 * Der Kontext des angemeldeten Nutzers, oder null.
 *
 * `cache` aus React haelt das Ergebnis fuer die Dauer EINES Requests fest.
 * Ohne das wuerde eine Seite, die Layout, Kontingentanzeige und Datenliste
 * rendert, denselben Nutzer dreimal aus der Datenbank lesen.
 */
export const getKontext = cache(async (): Promise<Kontext | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  return (await ladeKontext(userId)) ?? (await anlegenFallsNoetig(userId));
});

/** Wie `getKontext`, wirft aber statt null zu liefern. */
export async function requireKontext(): Promise<Kontext> {
  const kontext = await getKontext();
  if (!kontext) throw new NotSignedInError();
  return kontext;
}

/** Nur die Nutzer-ID — der haeufigste Fall in schreibenden Routen. */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new NotSignedInError();
  return userId;
}

/**
 * Verlangt die Adminrolle. Quelle der Wahrheit ist users.is_admin in
 * Postgres, nicht ein Clerk-Metadatum: die Rolle entscheidet ueber Plaene und
 * Kontingente aller Nutzer und soll dort liegen, wo auch diese Daten liegen.
 */
export async function requireAdmin(): Promise<Kontext> {
  const kontext = await requireKontext();
  if (!kontext.isAdmin) throw new NotAdminError();
  return kontext;
}
