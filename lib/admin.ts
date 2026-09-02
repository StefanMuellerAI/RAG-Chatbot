import { and, asc, count, desc, eq, gte, ilike, or, sql, sum } from "drizzle-orm";
import { getDb } from "./db";
import {
  collections,
  documents,
  models,
  plans,
  sizeClasses,
  usageEvents,
  users,
} from "./db/schema";
import type { ModelRow, Plan, SizeClass } from "./db/schema";
import { ValidationError } from "./errors";
import { verwirfModellkatalog } from "./modellkatalog";
import {
  ANBIETER_LABEL,
  KENNUNG_MAX_ZEICHEN,
  KENNUNG_MUSTER,
  LABEL_MAX_ZEICHEN,
  istAnbieter,
  istKeyAnbieter,
  zerlegeKennung,
  type Anbieter,
} from "./models";
import { kontextSchluessel, verwirfZwischenspeicher } from "./ratelimit";

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

  const db = getDb();

  // Eine unbekannte oder abgeschaltete Modellkennung wuerde erst beim ersten
  // Modellaufruf auffallen - also beim Nutzer und nicht beim Admin, der sie
  // eingetragen hat.
  const modell = await db.query.models.findFirst({ where: eq(models.id, eingabe.modelId) });
  if (!modell) {
    throw new ValidationError(
      `"${eingabe.modelId}" steht nicht im Modellkatalog. Zulaessig sind die im Auswahlfeld angebotenen Modelle.`,
    );
  }
  if (!modell.enabled) {
    throw new ValidationError(
      `Das Modell "${eingabe.modelId}" ist im Katalog nicht aktiv. Bitte zuerst aktivieren oder ein anderes waehlen.`,
    );
  }

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

  // Hinweis zur Wirkung: Der Nutzerkontext liegt bis zu eine Minute im
  // Zwischenspeicher. Eine Aenderung an der Plan-DEFINITION greift daher
  // fuer die betroffenen Nutzer erst innerhalb der naechsten Minute. Anders als
  // bei der Zuweisung eines Plans an eine einzelne Person wird hier bewusst
  // nicht verworfen: Das betraefe alle Nutzer des Plans, und ein Admin, der
  // Grenzen anpasst, wartet nicht auf die sekundengenaue Wirkung.
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

// --- Modellkatalog ----------------------------------------------------------

export type KatalogEintrag = Omit<ModelRow, "createdAt" | "updatedAt"> & {
  /** Plaene, die dieses Modell nutzen — entscheidet, ob es geloescht werden darf. */
  plaene: string[];
};

/** Alle Katalogeintraege, mit den Plaenen, die sie nutzen. Ohne Zwischenspeicher. */
export async function ladeModellKatalog(): Promise<KatalogEintrag[]> {
  const db = getDb();

  const [zeilen, planZeilen] = await Promise.all([
    db.select().from(models).orderBy(asc(models.sortOrder), asc(models.id)),
    db.select({ id: plans.id, modelId: plans.modelId }).from(plans),
  ]);

  return zeilen.map((zeile) => ({
    id: zeile.id,
    provider: zeile.provider,
    label: zeile.label,
    inputPerMillion: zeile.inputPerMillion,
    outputPerMillion: zeile.outputPerMillion,
    cacheReadPerMillion: zeile.cacheReadPerMillion,
    enabled: zeile.enabled,
    sortOrder: zeile.sortOrder,
    plaene: planZeilen.filter((plan) => plan.modelId === zeile.id).map((plan) => plan.id),
  }));
}

export type ModellEingabe = {
  id: string;
  provider: Anbieter;
  label: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  enabled: boolean;
  sortOrder: number;
};

/** Prueft eine Kennung und liefert sie getrimmt zurueck. */
export function pruefeKennung(id: unknown): string {
  const wert = typeof id === "string" ? id.trim() : "";
  if (!wert || wert.length > KENNUNG_MAX_ZEICHEN || !KENNUNG_MUSTER.test(wert)) {
    throw new ValidationError(
      'Die Kennung muss die Form "anbieter/modell" haben, z. B. "anthropic/claude-sonnet-4-5" ' +
        "oder \"google/gemini-2.5-flash\" — Praefix klein, ohne Leerzeichen.",
    );
  }
  return wert;
}

export async function speichereModell(eingabe: ModellEingabe): Promise<void> {
  const id = pruefeKennung(eingabe.id);

  if (!istAnbieter(eingabe.provider)) {
    throw new ValidationError("Unbekannter Anbieter. Zulaessig sind AI Gateway, Anthropic und OpenAI.");
  }

  // Bei direkter Anbindung geht die native Kennung an den Anbieter. Ein
  // "google/…"-Modell direkt an Anthropic zu schicken kann nur scheitern —
  // und zwar erst beim Nutzer.
  if (istKeyAnbieter(eingabe.provider) && zerlegeKennung(id).praefix !== eingabe.provider) {
    throw new ValidationError(
      `Fuer die direkte Anbindung an ${ANBIETER_LABEL[eingabe.provider]} muss die Kennung mit "${eingabe.provider}/" beginnen.`,
    );
  }

  const label = eingabe.label.trim();
  if (!label) throw new ValidationError("Die Bezeichnung darf nicht leer sein.");
  if (label.length > LABEL_MAX_ZEICHEN) {
    throw new ValidationError(`Die Bezeichnung darf hoechstens ${LABEL_MAX_ZEICHEN} Zeichen haben.`);
  }

  pruefePreis(eingabe.inputPerMillion, "Eingabepreis");
  pruefePreis(eingabe.outputPerMillion, "Ausgabepreis");
  pruefePreis(eingabe.cacheReadPerMillion, "Cache-Preis");
  pruefeGanzzahl(eingabe.sortOrder, 0, 9_999, "Sortierung");

  // Ohne Preise wuerde jede Antwort mit 0 $ verbucht und die Verbrauchsuebersicht
  // laege still falsch. Deshalb erst aktiv, wenn beide Preise eingetragen sind.
  if (eingabe.enabled && (eingabe.inputPerMillion <= 0 || eingabe.outputPerMillion <= 0)) {
    throw new ValidationError(
      "Bitte Eingabe- und Ausgabepreis eintragen, bevor das Modell aktiv gesetzt wird — sonst wird der Verbrauch mit 0 $ verbucht.",
    );
  }

  const db = getDb();

  // Ein Modell, das ein Plan nutzt, darf nicht abgeschaltet werden: Der Plan
  // wuerde still auf das Standardmodell fallen, ohne dass es jemand sieht.
  if (!eingabe.enabled) {
    const nutzer = await db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.modelId, id));
    if (nutzer.length > 0) {
      throw new ValidationError(
        `Das Modell wird von ${nutzer.length === 1 ? "dem Plan" : "den Plaenen"} ${nutzer
          .map((plan) => `"${plan.id}"`)
          .join(", ")} genutzt. Bitte dort zuerst ein anderes Modell waehlen.`,
      );
    }
  }

  const werte = {
    provider: eingabe.provider,
    label,
    inputPerMillion: eingabe.inputPerMillion,
    outputPerMillion: eingabe.outputPerMillion,
    cacheReadPerMillion: eingabe.cacheReadPerMillion,
    enabled: eingabe.enabled,
    sortOrder: eingabe.sortOrder,
    updatedAt: new Date(),
  };

  await db
    .insert(models)
    .values({ id, ...werte })
    .onConflictDoUpdate({ target: models.id, set: werte });

  await verwirfModellkatalog();
}

export async function loescheModell(id: string): Promise<void> {
  const db = getDb();

  const nutzer = await db.select({ id: plans.id }).from(plans).where(eq(plans.modelId, id));
  if (nutzer.length > 0) {
    throw new ValidationError(
      `Das Modell wird von ${nutzer.length === 1 ? "dem Plan" : "den Plaenen"} ${nutzer
        .map((plan) => `"${plan.id}"`)
        .join(", ")} genutzt. Bitte dort zuerst ein anderes Modell waehlen.`,
    );
  }

  await db.delete(models).where(eq(models.id, id));
  await verwirfModellkatalog();
}

function pruefePreis(wert: number, bezeichnung: string): void {
  if (!Number.isFinite(wert) || wert < 0 || wert > 10_000) {
    throw new ValidationError(
      `${bezeichnung}: erwartet wird ein Betrag in US-Dollar je 1 Mio. Token zwischen 0 und 10.000.`,
    );
  }
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

  // Der Nutzerkontext liegt eine Minute im Zwischenspeicher. Ohne diesen
  // Aufruf wuerde der Admin die Umstellung speichern, in der Nutzerliste sofort
  // sehen — und der Nutzer haette bis zu eine Minute noch die alten Grenzen.
  await verwirfZwischenspeicher(kontextSchluessel(clerkUserId));
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

  await verwirfZwischenspeicher(kontextSchluessel(clerkUserId));
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
