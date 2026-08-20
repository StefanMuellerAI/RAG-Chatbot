import { count, eq } from "drizzle-orm";
import type { Kontext } from "./auth/user";
import { getDb } from "./db";
import { collections } from "./db/schema";
import type { Collection, SizeClass } from "./db/schema";
import { QuotaError, ValidationError } from "./errors";

/**
 * Kontingentpruefungen.
 *
 * An einer Stelle gebuendelt, weil dieselben Grenzen an mehreren Stellen
 * greifen muessen: die Dateigroesse schon bei der Ausgabe des Upload-Tokens,
 * die Seitenzahl erst nach der Textextraktion — vorher weiss niemand, wie viele
 * Seiten in einer Datei stecken.
 *
 * Alle Meldungen nennen den erreichten Wert und die Grenze. "Kontingent
 * erschoepft" allein laesst den Nutzer raten, ob eine Datei zu gross war oder
 * die Sammlung zu voll.
 */

/** Darf der Nutzer eine weitere Sammlung anlegen? */
export async function pruefeNeueSammlung(kontext: Kontext): Promise<void> {
  const [{ vorhanden }] = await getDb()
    .select({ vorhanden: count() })
    .from(collections)
    .where(eq(collections.userId, kontext.userId));

  if (vorhanden >= kontext.plan.maxCollections) {
    throw new QuotaError(
      `Ihr Plan "${kontext.plan.label}" erlaubt ${kontext.plan.maxCollections} ` +
        `${kontext.plan.maxCollections === 1 ? "Sammlung" : "Sammlungen"}; ` +
        `es ${vorhanden === 1 ? "existiert" : "existieren"} bereits ${vorhanden}. ` +
        `Loeschen Sie eine Sammlung oder lassen Sie Ihren Plan anheben.`,
      vorhanden,
      kontext.plan.maxCollections,
    );
  }
}

/** Darf der Nutzer eine Sammlung dieser Groessenklasse anlegen? */
export function pruefeGroessenklasse(kontext: Kontext, klasse: SizeClass): void {
  if (klasse.rank > kontext.maxSizeClass.rank) {
    throw new QuotaError(
      `Ihr Plan "${kontext.plan.label}" reicht bis zur Groessenklasse ` +
        `${kontext.maxSizeClass.id}. Fuer ${klasse.id} braucht es einen hoeheren Plan.`,
      klasse.rank,
      kontext.maxSizeClass.rank,
    );
  }
}

/**
 * Passt ein weiteres Dokument dieser Groesse in die Sammlung?
 *
 * Wird VOR dem Upload aufgerufen, prueft daher nur, was vorher bekannt ist:
 * Anzahl der Dokumente und Dateigroesse.
 */
export function pruefeNeuesDokument(
  sammlung: Pick<Collection, "name" | "documentCount">,
  klasse: Pick<SizeClass, "id" | "maxDocuments" | "maxFileBytes">,
  dateiGroesse: number,
): void {
  if (sammlung.documentCount >= klasse.maxDocuments) {
    throw new QuotaError(
      `Die Sammlung "${sammlung.name}" ist voll: Groessenklasse ${klasse.id} erlaubt ` +
        `${klasse.maxDocuments} Dokumente. Legen Sie eine weitere Sammlung an oder ` +
        `entfernen Sie Dokumente.`,
      sammlung.documentCount,
      klasse.maxDocuments,
    );
  }

  if (dateiGroesse > klasse.maxFileBytes) {
    throw new QuotaError(
      `Die Datei ist ${megabyte(dateiGroesse)} gross; Groessenklasse ${klasse.id} erlaubt ` +
        `${megabyte(klasse.maxFileBytes)} je Datei.`,
      dateiGroesse,
      klasse.maxFileBytes,
    );
  }
}

/**
 * Passt die tatsaechliche Seitenzahl noch in die Grenzen?
 *
 * Wird NACH der Textextraktion aufgerufen. Ein 400-seitiges PDF kann als
 * 3-MB-Datei ankommen und alle Groessenpruefungen vorher bestehen — die
 * Seitengrenze ist deshalb nicht nachtraeglich, sondern zwingend zweistufig.
 */
/*
 * Beide Pruefungen nehmen nur die Felder, die sie wirklich lesen. Das ist keine
 * Kosmetik: Der Ingestion-Ablauf hat an dieser Stelle keine vollstaendigen
 * Datensaetze zur Hand, sondern nur die Werte, die er durch seine Schritte
 * traegt — mit den vollen Typen liesse sich die Pruefung dort nur ueber
 * vorgetaeuschte Objekte aufrufen.
 */
export function pruefeSeitenzahl(
  sammlung: Pick<Collection, "name" | "pageCount">,
  klasse: Pick<SizeClass, "id" | "maxPagesPerDocument" | "maxTotalPages">,
  seiten: number,
): void {
  if (seiten > klasse.maxPagesPerDocument) {
    throw new QuotaError(
      `Das Dokument hat ${seiten} Seiten; Groessenklasse ${klasse.id} erlaubt ` +
        `${klasse.maxPagesPerDocument} Seiten je Dokument.`,
      seiten,
      klasse.maxPagesPerDocument,
    );
  }

  const nachher = sammlung.pageCount + seiten;
  if (nachher > klasse.maxTotalPages) {
    throw new QuotaError(
      `Mit diesem Dokument haette die Sammlung ${nachher} Seiten; Groessenklasse ` +
        `${klasse.id} erlaubt insgesamt ${klasse.maxTotalPages}.`,
      nachher,
      klasse.maxTotalPages,
    );
  }
}

/** Name und Beschreibung einer Sammlung pruefen und normalisieren. */
export function pruefeSammlungsText(name: unknown, beschreibung: unknown): {
  name: string;
  beschreibung: string;
} {
  const sauberName = String(name ?? "").replace(/\s+/g, " ").trim();
  if (sauberName.length < 2 || sauberName.length > 80) {
    throw new ValidationError("Der Name muss zwischen 2 und 80 Zeichen lang sein.");
  }

  // Die Beschreibung geht in den Katalog, den das Modell beim Tool-Aufruf sieht.
  // Eine Obergrenze ist deshalb keine Formalie: bei vielen Sammlungen summieren
  // sich die Beschreibungen zu einem betraechtlichen Teil jedes Prompts.
  const sauberBeschreibung = String(beschreibung ?? "").replace(/\s+/g, " ").trim();
  if (sauberBeschreibung.length > 400) {
    throw new ValidationError("Die Beschreibung darf hoechstens 400 Zeichen lang sein.");
  }

  return { name: sauberName, beschreibung: sauberBeschreibung };
}

function megabyte(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
