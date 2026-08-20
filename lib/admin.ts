import { and, count, desc, eq, gte, ilike, or, sql, sum } from "drizzle-orm";
import { getDb } from "./db";
import {
  collections,
  documents,
  plans,
  sizeClasses,
  usageEvents,
  users,
} from "./db/schema";
import type { Plan, SizeClass } from "./db/schema";
import { ValidationError } from "./errors";
import { isKnownModel } from "./models";

/**
 * Datenzugriff des Admin-Bereichs.
 *
 * Alle Funktionen setzen voraus, dass die Rolle bereits geprueft wurde
 * (requireAdmin in der jeweiligen Route). Diese Schicht prueft Werte, nicht
 * Berechtigungen.
 */

const EIN_MB = 1024 * 1024;

// --- Groessenklassen --------------------------------------------------------

export async function ladeGroessenklassen(): Promise<SizeClass[]> {
  return getDb().select().from(sizeClasses).orderBy(sizeClasses.rank);
}

export type GroessenklasseEingabe = {
  id: string;
  label: string;
  rank: number;
  maxDocuments: number;
  maxPagesPerDocument: number;
  maxTotalPages: number;
  maxFileMegabytes: number;
};

export async function speichereGroessenklasse(eingabe: GroessenklasseEingabe): Promise<void> {
  pruefeGanzzahl(eingabe.rank, 1, 999, "Rang");
  pruefeGanzzahl(eingabe.maxDocuments, 1, 1_000_000, "Dokumente je Sammlung");
  pruefeGanzzahl(eingabe.maxPagesPerDocument, 1, 100_000, "Seiten je Dokument");
  pruefeGanzzahl(eingabe.maxTotalPages, 1, 100_000_000, "Seiten gesamt");
  pruefeGanzzahl(eingabe.maxFileMegabytes, 1, 2_000, "Dateigroesse in MB");

  if (!eingabe.label.trim()) {
    throw new ValidationError("Die Bezeichnung darf nicht leer sein.");
  }

  // Eine Gesamtgrenze unterhalb der Grenze fuer ein einzelnes Dokument waere
  // widerspruechlich: schon das erste Dokument koennte sie reissen.
  if (eingabe.maxTotalPages < eingabe.maxPagesPerDocument) {
    throw new ValidationError(
      "Die Gesamtseitenzahl darf nicht kleiner sein als die Seitenzahl je Dokument.",
    );
  }

  const db = getDb();
  const werte = {
    label: eingabe.label.trim(),
    rank: eingabe.rank,
    maxDocuments: eingabe.maxDocuments,
    maxPagesPerDocument: eingabe.maxPagesPerDocument,
    maxTotalPages: eingabe.maxTotalPages,
    maxFileBytes: eingabe.maxFileMegabytes * EIN_MB,
    updatedAt: new Date(),
  };

  await db
    .insert(sizeClasses)
    .values({ id: eingabe.id, ...werte })
    .onConflictDoUpdate({ target: sizeClasses.id, set: werte });
}

// --- Plaene -----------------------------------------------------------------

export type PlanMitKlasse = Plan & { maxSizeClass: SizeClass };

export async function ladePlaene(): Promise<PlanMitKlasse[]> {
  const zeilen = await getDb()
    .select({ plan: plans, maxSizeClass: sizeClasses })
    .from(plans)
    .innerJoin(sizeClasses, eq(plans.maxSizeClassId, sizeClasses.id))
    .orderBy(sizeClasses.rank);

  return zeilen.map((zeile) => ({ ...zeile.plan, maxSizeClass: zeile.maxSizeClass }));
}

export type PlanEingabe = {
  id: string;
  label: string;
  maxSizeClassId: string;
  maxCollections: number;
  maxQuestionsPerDay: number;
  modelId: string;
  isDefault: boolean;
};

export async function speicherePlan(eingabe: PlanEingabe): Promise<void> {
  pruefeGanzzahl(eingabe.maxCollections, 0, 100_000, "Sammlungen je Nutzer");
  pruefeGanzzahl(eingabe.maxQuestionsPerDay, 0, 10_000_000, "Fragen je Tag");

  if (!eingabe.label.trim()) {
    throw new ValidationError("Die Bezeichnung darf nicht leer sein.");
  }

  // Eine unbekannte Modellkennung wuerde erst beim ersten Modellaufruf
  // auffallen - also beim Nutzer und nicht beim Admin, der sie eingetragen hat.
  if (!isKnownModel(eingabe.modelId)) {
    throw new ValidationError(
      `"${eingabe.modelId}" ist keine bekannte Modellkennung. Zulaessig sind die im Auswahlfeld angebotenen Modelle.`,
    );
  }

  const db = getDb();

  const klasse = await db.query.sizeClasses.findFirst({
    where: eq(sizeClasses.id, eingabe.maxSizeClassId),
  });
  if (!klasse) {
    throw new ValidationError(`Die Groessenklasse "${eingabe.maxSizeClassId}" existiert nicht.`);
  }

  const werte = {
    label: eingabe.label.trim(),
    maxSizeClassId: eingabe.maxSizeClassId,
    maxCollections: eingabe.maxCollections,
    maxQuestionsPerDay: eingabe.maxQuestionsPerDay,
    modelId: eingabe.modelId,
    isDefault: eingabe.isDefault,
    updatedAt: new Date(),
  };

  const speichern = db
    .insert(plans)
    .values({ id: eingabe.id, ...werte })
    .onConflictDoUpdate({ target: plans.id, set: werte });

  if (!eingabe.isDefault) {
    await speichern;
    return;
  }

  // Genau ein Plan darf Standard sein. Beide Anweisungen muessen zusammen
  // greifen, sonst gibt es zwischenzeitlich zwei Standardplaene (oder keinen,
  // falls die zweite Anweisung scheitert) und neue Registrierungen laufen ins
  // Leere. `batch` fuehrt sie als eine Transaktion aus.
  await db.batch([
    db.update(plans).set({ isDefault: false }).where(sql`${plans.isDefault} = true`),
    speichern,
  ]);
}

export async function loeschePlan(planId: string): Promise<void> {
  const db = getDb();

  const [{ anzahl }] = await db
    .select({ anzahl: count() })
    .from(users)
    .where(eq(users.planId, planId));

  if (anzahl > 0) {
    throw new ValidationError(
      `Dem Plan sind noch ${anzahl} Nutzer zugewiesen. Bitte diese zuerst auf einen anderen Plan setzen.`,
    );
  }

  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (plan?.isDefault) {
    throw new ValidationError(
      "Der Standardplan kann nicht geloescht werden. Bitte zuerst einen anderen Plan als Standard markieren.",
    );
  }

  await db.delete(plans).where(eq(plans.id, planId));
}

// --- Nutzer -----------------------------------------------------------------

export type NutzerZeile = {
  clerkUserId: string;
  email: string | null;
  name: string | null;
  planId: string;
  isAdmin: boolean;
  createdAt: Date;
  collectionCount: number;
  documentCount: number;
};

export type NutzerSeite = {
  zeilen: NutzerZeile[];
  gesamt: number;
  seite: number;
  seiten: number;
};

const SEITENGROESSE = 25;

/**
 * Nutzerliste, seitenweise und durchsuchbar.
 *
 * Bei 15.000 Nutzern ist eine vollstaendige Liste weder darstellbar noch
 * bezahlbar; die Zaehlungen kommen deshalb aus Unterabfragen und nicht aus
 * einem Join ueber alle Dokumente.
 */
export async function ladeNutzer(suche: string, seite: number): Promise<NutzerSeite> {
  const db = getDb();
  const begriff = suche.trim();

  const filter = begriff
    ? or(ilike(users.email, `%${begriff}%`), ilike(users.name, `%${begriff}%`),
        eq(users.clerkUserId, begriff))
    : undefined;

  const [{ gesamt }] = await db
    .select({ gesamt: count() })
    .from(users)
    .where(filter);

  const seiten = Math.max(Math.ceil(gesamt / SEITENGROESSE), 1);
  const aktuelleSeite = Math.min(Math.max(seite, 1), seiten);

  const zeilen = await db
    .select({
      clerkUserId: users.clerkUserId,
      email: users.email,
      name: users.name,
      planId: users.planId,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      collectionCount: sql<number>`(
        select count(*)::int from ${collections} where ${collections.userId} = ${users.clerkUserId}
      )`,
      documentCount: sql<number>`(
        select count(*)::int from ${documents} where ${documents.userId} = ${users.clerkUserId}
      )`,
    })
    .from(users)
    .where(filter)
    .orderBy(desc(users.createdAt))
    .limit(SEITENGROESSE)
    .offset((aktuelleSeite - 1) * SEITENGROESSE);

  return { zeilen, gesamt, seite: aktuelleSeite, seiten };
}

export async function setzeNutzerPlan(clerkUserId: string, planId: string): Promise<void> {
  const db = getDb();

  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan) throw new ValidationError(`Der Plan "${planId}" existiert nicht.`);

  await db
    .update(users)
    .set({ planId, updatedAt: new Date() })
    .where(eq(users.clerkUserId, clerkUserId));
}

export async function setzeAdminRolle(
  clerkUserId: string,
  istAdmin: boolean,
  eigeneId: string,
): Promise<void> {
  // Wer sich selbst die Rolle nimmt, sperrt sich aus - und kann es nicht mehr
  // rueckgaengig machen, weil dafuer genau diese Rolle noetig waere.
  if (!istAdmin && clerkUserId === eigeneId) {
    throw new ValidationError(
      "Die eigene Adminrolle kann nicht entzogen werden. Bitte eine andere Person zum Admin machen und es diese tun lassen.",
    );
  }

  await getDb()
    .update(users)
    .set({ isAdmin: istAdmin, updatedAt: new Date() })
    .where(eq(users.clerkUserId, clerkUserId));
}

// --- Verbrauch --------------------------------------------------------------

export type VerbrauchZeile = {
  userId: string;
  email: string | null;
  fragen: number;
  kostenMicros: number;
};

export type VerbrauchUebersicht = {
  fragenHeute: number;
  kostenHeuteMicros: number;
  fragen30Tage: number;
  kosten30TageMicros: number;
  vielnutzer: VerbrauchZeile[];
};

/**
 * Verbrauchsuebersicht.
 *
 * Bei diesem Zuschnitt ist die Modellrechnung der groesste Posten des Betriebs.
 * Die Liste der Vielnutzer ist deshalb kein Beiwerk, sondern das Werkzeug, mit
 * dem sich eine aus dem Ruder laufende Rechnung einem Verursacher zuordnen laesst.
 */
export async function ladeVerbrauch(): Promise<VerbrauchUebersicht> {
  const db = getDb();
  const heute = tagesschluessel(0);
  const vor30Tagen = tagesschluessel(30);

  const [heuteZeile] = await db
    .select({
      fragen: count(),
      kosten: sum(usageEvents.costMicros).mapWith(Number),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.day, heute), eq(usageEvents.kind, "frage")));

  const [zeitraumZeile] = await db
    .select({
      fragen: count(),
      kosten: sum(usageEvents.costMicros).mapWith(Number),
    })
    .from(usageEvents)
    .where(and(gte(usageEvents.day, vor30Tagen), eq(usageEvents.kind, "frage")));

  const vielnutzer = await db
    .select({
      userId: usageEvents.userId,
      email: users.email,
      fragen: count(),
      kostenMicros: sum(usageEvents.costMicros).mapWith(Number),
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.clerkUserId, usageEvents.userId))
    .where(and(gte(usageEvents.day, vor30Tagen), eq(usageEvents.kind, "frage")))
    .groupBy(usageEvents.userId, users.email)
    .orderBy(desc(sum(usageEvents.costMicros)))
    .limit(20);

  return {
    fragenHeute: heuteZeile?.fragen ?? 0,
    kostenHeuteMicros: heuteZeile?.kosten ?? 0,
    fragen30Tage: zeitraumZeile?.fragen ?? 0,
    kosten30TageMicros: zeitraumZeile?.kosten ?? 0,
    vielnutzer: vielnutzer.map((zeile) => ({
      userId: zeile.userId,
      email: zeile.email,
      fragen: zeile.fragen,
      kostenMicros: zeile.kostenMicros ?? 0,
    })),
  };
}

/** Tagesschluessel in UTC, `vorTagen` Tage in der Vergangenheit. */
function tagesschluessel(vorTagen: number): string {
  const zeitpunkt = new Date();
  zeitpunkt.setUTCDate(zeitpunkt.getUTCDate() - vorTagen);
  return zeitpunkt.toISOString().slice(0, 10);
}

function pruefeGanzzahl(wert: number, min: number, max: number, bezeichnung: string): void {
  if (!Number.isInteger(wert) || wert < min || wert > max) {
    throw new ValidationError(
      `${bezeichnung}: erwartet wird eine ganze Zahl zwischen ${min} und ${max}.`,
    );
  }
}
