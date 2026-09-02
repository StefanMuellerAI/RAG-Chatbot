import { FatalError, RetryableError } from "workflow";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { modell } from "@/lib/ai";
import { setzeAutoBeschreibung } from "@/lib/collections";
import { getDb } from "@/lib/db";
import { collections, documents, sizeClasses } from "@/lib/db/schema";
import type { PresetId } from "@/lib/db/schema";
import type { CollectionKind } from "@/lib/collection-kinds";
import {
  leseDatei,
  schliesseDokumentAb,
  setzeDokumentStatus,
} from "@/lib/documents";
import { QuotaError, fehlerMeldung } from "@/lib/errors";
import { extractBlocks } from "@/lib/extract";
import { chunkBlocks } from "@/lib/chunk";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { findPreset } from "@/lib/presets";
import { pruefeSeitenzahl } from "@/lib/quota";
import { upsertChunks } from "@/lib/vector";
import { verbucheIngestion } from "@/lib/verbrauch";

/**
 * Dokumentverarbeitung als dauerhafter Ablauf.
 *
 * Vorher lief das synchron in einer Funktion mit 60 Sekunden Zeitfenster. Bei
 * Dokumenten mit hunderten Seiten reisst das regelmaessig, und ein Abbruch
 * mitten im Schreiben hinterliess ein Dokument, das halb in der Suche stand.
 *
 * Jetzt ist jeder Schritt einzeln wiederholbar. Weil die Abschnitts-IDs
 * deterministisch aus Dokument-ID und Nummer entstehen, ist ein erneuter
 * Schreibvorgang unschaedlich: er ueberschreibt dieselben Eintraege statt
 * Duplikate anzulegen. Genau das macht die Wiederholung eines Schrittes
 * gefahrlos.
 */

type Vorbereitung = {
  userId: string;
  collectionId: string;
  filename: string;
  contentType: string;
  blobPath: string;
  preset: PresetId;
  /** Sammlungstyp — steuert kuenftig, welcher Verarbeitungsweg gewaehlt wird. */
  kind: CollectionKind;
  /** Grenzen der Groessenklasse — die Seitenpruefung braucht sie im Schritt. */
  sizeClassId: string;
  maxPagesPerDocument: number;
  maxTotalPages: number;
  seitenBisher: number;
  sammlungsName: string;
};

/**
 * Sammelt alles, was die weiteren Schritte brauchen.
 *
 * Absichtlich ein eigener Schritt: Sein Ergebnis ist klein und wird bei einer
 * Wiederholung aus dem Ablaufspeicher gelesen statt erneut aus der Datenbank.
 */
async function bereiteVor(docId: string): Promise<Vorbereitung> {
  "use step";

  console.log(`[ingest ${docId}] Vorbereitung`);

  const db = getDb();

  const [zeile] = await db
    .select({
      dokument: documents,
      sammlung: collections,
      klasse: sizeClasses,
    })
    .from(documents)
    .innerJoin(collections, eq(documents.collectionId, collections.id))
    .innerJoin(sizeClasses, eq(collections.sizeClassId, sizeClasses.id))
    .where(eq(documents.id, docId))
    .limit(1);

  if (!zeile) {
    throw new FatalError(`Dokument ${docId} existiert nicht mehr.`);
  }

  await setzeDokumentStatus(docId, "laeuft");

  return {
    userId: zeile.dokument.userId,
    collectionId: zeile.dokument.collectionId,
    filename: zeile.dokument.filename,
    contentType: zeile.dokument.contentType,
    blobPath: zeile.dokument.blobPath,
    preset: zeile.sammlung.preset,
    kind: zeile.sammlung.kind,
    sizeClassId: zeile.klasse.id,
    maxPagesPerDocument: zeile.klasse.maxPagesPerDocument,
    maxTotalPages: zeile.klasse.maxTotalPages,
    seitenBisher: zeile.sammlung.pageCount,
    sammlungsName: zeile.sammlung.name,
  };
}

/**
 * Text gewinnen, pruefen, zerlegen und in die Vektor-Datenbank schreiben.
 *
 * Alles in EINEM Schritt, und das aus einem Grund: Der Volltext eines
 * umfangreichen Dokuments umfasst mehrere Megabyte. Zwischen Schritten
 * uebergeben wuerde er jedes Mal in den Ablaufspeicher geschrieben und wieder
 * gelesen. Er bleibt deshalb innerhalb eines Schrittes; nach draussen gehen nur
 * die beiden Zahlen, die noch gebraucht werden.
 *
 * Die Reihenfolge innerhalb des Schrittes ist wesentlich: Die Seitengrenze wird
 * geprueft, BEVOR etwas geschrieben wird. Andernfalls stuende ein zu grosses
 * Dokument bereits in der Suche, wenn die Ablehnung kommt.
 */
async function extrahiereUndSchreibe(
  docId: string,
  vorbereitung: Vorbereitung,
): Promise<{ seiten: number; abschnitte: number }> {
  "use step";

  console.log(`[ingest ${docId}] Extraktion von "${vorbereitung.filename}"`);

  const strom = await leseDatei(vorbereitung.blobPath);
  if (!strom) {
    throw new FatalError(
      "Die hochgeladene Datei wurde nicht gefunden. Bitte erneut hochladen.",
    );
  }

  const puffer = await new Response(strom).arrayBuffer();

  const { bloecke, seiten } = await extractBlocks(
    puffer,
    vorbereitung.filename,
    vorbereitung.contentType,
  );

  // Seitengrenze der Groessenklasse. Vorher nicht pruefbar: Die Seitenzahl
  // steht erst nach der Extraktion fest.
  try {
    pruefeSeitenzahl(
      { name: vorbereitung.sammlungsName, pageCount: vorbereitung.seitenBisher },
      {
        id: vorbereitung.sizeClassId,
        maxPagesPerDocument: vorbereitung.maxPagesPerDocument,
        maxTotalPages: vorbereitung.maxTotalPages,
      },
      seiten,
    );
  } catch (error) {
    // Eine gerissene Grenze behebt sich durch Wiederholen nicht.
    if (error instanceof QuotaError) throw new FatalError(error.message);
    throw error;
  }

  const preset = findPreset(vorbereitung.preset);
  const abschnitte = chunkBlocks(bloecke, preset);

  if (abschnitte.length === 0) {
    throw new FatalError(
      `Aus "${vorbereitung.filename}" liess sich kein Text gewinnen. Bei PDFs ist das ` +
        `meist ein Scan ohne Texterkennung — eine per OCR durchsuchbare Fassung waere ` +
        `hier noetig.`,
    );
  }

  console.log(
    `[ingest ${docId}] ${seiten} Seiten, ${abschnitte.length} Abschnitte (${preset.label})`,
  );

  try {
    await upsertChunks(
      vorbereitung.collectionId,
      docId,
      vorbereitung.filename,
      abschnitte,
    );
  } catch (error) {
    const meldung = fehlerMeldung(error);

    // Ueberlast ist voruebergehend und lohnt einen weiteren Versuch. Ein
    // falsch angelegter Index dagegen wird sich durch Wiederholen nie
    // beheben — das waere nur eine Schleife bis zum Zeitlimit.
    if (/429|ueberlastet|rate limit|timeout|ETIMEDOUT|ECONNRESET/i.test(meldung)) {
      throw new RetryableError(meldung, { retryAfter: "30s" });
    }

    throw new FatalError(meldung);
  }

  return { seiten, abschnitte: abschnitte.length };
}

async function schliesseAb(
  docId: string,
  vorbereitung: Vorbereitung,
  ergebnis: { seiten: number; abschnitte: number },
): Promise<void> {
  "use step";

  console.log(`[ingest ${docId}] Abschluss`);

  await schliesseDokumentAb(
    docId,
    vorbereitung.collectionId,
    ergebnis.seiten,
    ergebnis.abschnitte,
  );

  await verbucheIngestion(vorbereitung.userId, ergebnis.abschnitte);
}

/**
 * Schlaegt eine Beschreibung fuer die Sammlung vor.
 *
 * Das ist kein Beiwerk: Im Chat entscheidet das Modell anhand von Name und
 * Beschreibung, welche Sammlung es durchsucht. Eine Sammlung ohne Beschreibung
 * ist dort praktisch unsichtbar. Weil kaum jemand freiwillig ein Textfeld
 * ausfuellt, entsteht die Beschreibung hier aus dem, was tatsaechlich
 * drinsteht — und nur, wenn der Nutzer keine eigene hinterlegt hat.
 */
async function ergaenzeBeschreibung(collectionId: string): Promise<void> {
  "use step";

  const db = getDb();

  const sammlung = await db.query.collections.findFirst({
    where: eq(collections.id, collectionId),
  });

  if (!sammlung || sammlung.description || sammlung.descriptionSource !== "auto") {
    return;
  }

  const dateien = await db
    .select({ filename: documents.filename })
    .from(documents)
    .where(eq(documents.collectionId, collectionId))
    .limit(25);

  if (dateien.length === 0) return;

  console.log(`[ingest] Beschreibung fuer Sammlung ${collectionId} vorschlagen`);

  try {
    const { text } = await generateText({
      // Bewusst das guenstigste Modell: Es geht um einen Satz aus einer Liste
      // von Dateinamen, nicht um eine inhaltliche Leistung.
      model: modell(DEFAULT_MODEL_ID),
      instructions:
        "Du formulierst eine knappe Inhaltsangabe fuer eine Dokumentensammlung. " +
        "Ein Satz, hoechstens 200 Zeichen, auf Deutsch, ohne Einleitung und ohne " +
        "Anfuehrungszeichen. Sie soll erkennbar machen, wann sich eine Suche in " +
        "dieser Sammlung lohnt.",
      prompt:
        `Sammlung "${sammlung.name}" enthaelt diese Dateien:\n` +
        dateien.map((datei) => `- ${datei.filename}`).join("\n"),
    });

    await setzeAutoBeschreibung(collectionId, text);
  } catch (error) {
    // Eine misslungene Beschreibung darf die Verarbeitung nicht scheitern
    // lassen — das Dokument ist da und durchsuchbar, darauf kommt es an.
    console.warn("Beschreibung konnte nicht vorgeschlagen werden.", error);
  }
}

/** Haelt den Fehler am Dokument fest, damit die Oberflaeche ihn anzeigen kann. */
async function vermerkeFehler(docId: string, meldung: string): Promise<void> {
  "use step";

  console.error(`[ingest ${docId}] fehlgeschlagen: ${meldung}`);
  await setzeDokumentStatus(docId, "fehler", { error: meldung.slice(0, 1000) });
}

export async function verarbeiteDokument(docId: string): Promise<void> {
  "use workflow";

  try {
    const vorbereitung = await bereiteVor(docId);
    const ergebnis = await extrahiereUndSchreibe(docId, vorbereitung);
    await schliesseAb(docId, vorbereitung, ergebnis);
    await ergaenzeBeschreibung(vorbereitung.collectionId);
  } catch (error) {
    // Der Fehler muss am Dokument landen, sonst steht es bis in alle Ewigkeit
    // auf "laeuft" und der Nutzer erfaehrt nie, woran es lag.
    await vermerkeFehler(docId, fehlerMeldung(error));
    throw error;
  }
}
