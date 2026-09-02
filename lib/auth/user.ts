import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "../db";
import { seedStammdaten } from "../db/seed";
import { plans, sizeClasses, users } from "../db/schema";
import type { Plan, SizeClass } from "../db/schema";
import { planAusEinladung } from "../einladungen";
import { ausZwischenspeicher, kontextSchluessel } from "../ratelimit";

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

/**
 * Nutzer samt aufgeloestem Plan und dessen hoechster Groessenklasse.
 *
 * Ohne `updatedAt`, und das mit Bedacht: Der Kontext wird in Redis
 * zwischengespeichert, und daraus kommen Datumsangaben als Zeichenketten
 * zurueck. Ein Feld vom Typ Date zu fuehren, das zur Laufzeit ein String ist,
 * waere eine Falle fuer den naechsten, der darauf `getFullYear` aufruft.
 * Gebraucht wird es hier ohnehin nicht.
 */
export type Kontext = {
  userId: string;
  isAdmin: boolean;
  plan: Omit<Plan, "updatedAt">;
  maxSizeClass: Omit<SizeClass, "updatedAt">;
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

  // Ohne bestehenden Admin gaebe es niemanden, der die Rolle in der
  // Oberflaeche vergeben kann. Der erste Nutzer ist deshalb Admin — danach
  // bleibt die Rolle eine bewusste Entscheidung in der Nutzerliste.
  const schonEinAdmin = await db.query.users.findFirst({
    columns: { clerkUserId: true },
    where: eq(users.isAdmin, true),
  });

  // Wer ueber eine Einladung kommt, bringt den vom Admin vorgegebenen Plan in
  // den Clerk-Metadaten mit. Der Webhook liest ihn ebenso — aber die erste
  // Seite des neuen Nutzers ist oft schneller als die Zustellung, und bei
  // `user.created` bleibt der Plan einer schon vorhandenen Zeile unangetastet.
  // Ohne diesen Griff ginge die Vorgabe genau dann verloren.
  const planId = (await planAusEinladung(clerk?.publicMetadata)) ?? plan.id;

  await db
    .insert(users)
    .values({
      clerkUserId,
      email: clerk?.primaryEmailAddress?.emailAddress ?? null,
      name: [clerk?.firstName, clerk?.lastName].filter(Boolean).join(" ") || null,
      planId,
      isAdmin: !schonEinAdmin,
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
      plan: {
        id: plans.id,
        label: plans.label,
        maxSizeClassId: plans.maxSizeClassId,
        maxCollections: plans.maxCollections,
        maxQuestionsPerDay: plans.maxQuestionsPerDay,
        modelId: plans.modelId,
        isDefault: plans.isDefault,
      },
      maxSizeClass: {
        id: sizeClasses.id,
        label: sizeClasses.label,
        rank: sizeClasses.rank,
        maxDocuments: sizeClasses.maxDocuments,
        maxPagesPerDocument: sizeClasses.maxPagesPerDocument,
        maxTotalPages: sizeClasses.maxTotalPages,
        maxFileBytes: sizeClasses.maxFileBytes,
      },
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
 * Zwei Ebenen von Zwischenspeicherung, die verschiedene Dinge tun:
 *
 * `cache` aus React haelt das Ergebnis fuer die Dauer EINES Requests fest. Ohne
 * das wuerde eine Seite, die Layout, Kontingentanzeige und Datenliste rendert,
 * denselben Nutzer dreimal aus der Datenbank lesen.
 *
 * Redis haelt es darueber hinaus eine Minute lang. Plan, Rolle und
 * Groessenklasse aendern sich nur durch eine Admin-Entscheidung, werden aber bei
 * jeder Frage gebraucht — bei 5.000 Fragen pro Minute waeren das 5.000
 * Datenbankabfragen fuer unveraenderte Werte. Der Preis dafuer ist, dass eine
 * Planaenderung bis zu eine Minute braucht, bis sie greift.
 */
export const getKontext = cache(async (): Promise<Kontext | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  return ausZwischenspeicher(
    kontextSchluessel(userId),
    KONTEXT_LEBENSDAUER_SEKUNDEN,
    async () => (await ladeKontext(userId)) ?? (await anlegenFallsNoetig(userId)),
  );
});

const KONTEXT_LEBENSDAUER_SEKUNDEN = 60;

/**
 * Wie `getKontext`, wirft aber statt null zu liefern.
 *
 * Fuer API-Routen. Der Fehler wird in lib/api.ts zu einem 401 mit JSON — das
 * ist, was ein `fetch` im Browser verarbeiten kann.
 */
export async function requireKontext(): Promise<Kontext> {
  const kontext = await getKontext();
  if (!kontext) throw new NotSignedInError();
  return kontext;
}

/**
 * Fuer Seiten: leitet zur Anmeldung, statt zu werfen.
 *
 * Eine Seite, die mit einem Fehler antwortet, weil niemand angemeldet ist,
 * waere fuer den Nutzer eine Sackgasse. Nach der Anmeldung kommt er ueber
 * `redirect_url` dorthin zurueck, wo er hinwollte.
 */
export async function requireKontextFuerSeite(zielpfad?: string): Promise<Kontext> {
  const kontext = await getKontext();
  if (kontext) return kontext;

  const ziel = zielpfad
    ? `/sign-in?redirect_url=${encodeURIComponent(zielpfad)}`
    : "/sign-in";

  redirect(ziel);
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
