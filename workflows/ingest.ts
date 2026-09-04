import { FatalError, RetryableError } from "workflow";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { modell } from "@/lib/ai";
import { setzeAutoBeschreibung } from "@/lib/collections";
import { getDb } from "@/lib/db";
import { collections, documents, sizeClasses } from "@/lib/db/schema";
import type { CollectionKind } from "@/lib/collection-kinds";
import {
  entferneDokumentSatz,
  ladeDokumenteDerSammlung,
  leseDatei,
  leseDateiFenster,
  loescheDatei,
  schliesseDokumentAb,
  setzeDokumentStatus,
} from "@/lib/documents";
import { MissingConfigError } from "@/lib/env";
import { QuotaError, ValidationError, fehlerMeldung } from "@/lib/errors";
import { extractBlocks, istMp3 } from "@/lib/extract";
import { chunkBlocks } from "@/lib/chunk";
import { ersetzteDokumente, ingestGraph, ingestSql } from "@/lib/ingest";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { planeMp3Teile, type Mp3Teil } from "@/lib/mp3-teile";
import { effektiveVerarbeitung, type Verarbeitung } from "@/lib/presets";
import { pruefeSeitenzahl } from "@/lib/quota";
import { erwirbSperre, gibSperreFrei, sperrSchluessel } from "@/lib/ratelimit";
import {
  fuegeTranskripteZusammen,
  transkribiereMp3Teil,
  type TranskriptTeilErgebnis,
} from "@/lib/transcribe";
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
 * gefahrlos. MP3s gehen in mehrere Schritte (Rahmenplan, je Teilstueck eine
 * Transkription, dann Schreiben), damit ein langer Mitschnitt nicht an einem
 * Timeout haengt und ein fehlgeschlagener Teil allein wiederholt wird.
 */

type Vorbereitung = {
  userId: string;
  collectionId: string;
  filename: string;
  contentType: string;
  blobPath: string;
  /** Preset samt Abweichungen aus dem Expertenmodus — steuert das Zerlegen. */
  verarbeitung: Verarbeitung;
  /** Sammlungstyp — entscheidet, welcher Verarbeitungsschritt laeuft. */
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
    verarbeitung: effektiveVerarbeitung(zeile.sammlung),
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

  const { verarbeitung } = vorbereitung;
  const abschnitte = chunkBlocks(bloecke, verarbeitung);

  if (abschnitte.length === 0) {
    throw new FatalError(
      `Aus "${vorbereitung.filename}" liess sich kein Text gewinnen. Bei PDFs ist das ` +
        `meist ein Scan ohne Texterkennung — eine per OCR durchsuchbare Fassung waere ` +
        `hier noetig.`,
    );
  }

  console.log(
    `[ingest ${docId}] ${seiten} Seiten, ${abschnitte.length} Abschnitte (${beschreibeVerarbeitung(verarbeitung)})`,
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

/**
 * MP3: Rahmenplan, je Teil ein eigener Schritt, danach zusammenfuegen und
 * schreiben. So bleibt ein Fehler in Teil 7 eine Wiederholung von Teil 7,
 * und der Ablaufspeicher haelt nur Text, nicht die Audiodaten.
 */
async function verarbeiteAudio(
  docId: string,
  vorbereitung: Vorbereitung,
): Promise<{ seiten: number; abschnitte: number }> {
  const plan = await planeAudioTeile(docId, vorbereitung);
  console.log(`[ingest ${docId}] MP3 in ${plan.length} Teil(e) fuer die Transkription`);

  const teile: TranskriptTeilErgebnis[] = [];
  for (const [index, teil] of plan.entries()) {
    console.log(
      `[ingest ${docId}] Transkription ${index + 1}/${plan.length} ` +
        `(Bytes ${teil.startByte}–${teil.endByte})`,
    );
    teile.push(await transkribiereAudioTeil(vorbereitung, teil));
  }

  return schreibeAudioChunks(docId, vorbereitung, teile);
}

async function planeAudioTeile(
  docId: string,
  vorbereitung: Vorbereitung,
): Promise<Mp3Teil[]> {
  "use step";

  console.log(`[ingest ${docId}] MPEG-Rahmen von "${vorbereitung.filename}" lesen`);

  const strom = await leseDatei(vorbereitung.blobPath);
  if (!strom) {
    throw new FatalError(
      "Die hochgeladene Datei wurde nicht gefunden. Bitte erneut hochladen.",
    );
  }

  try {
    return await planeMp3Teile(strom);
  } catch (error) {
    alsAblauffehler(error);
  }
}

async function transkribiereAudioTeil(
  vorbereitung: Vorbereitung,
  teil: Mp3Teil,
): Promise<TranskriptTeilErgebnis> {
  "use step";

  const bytes = await leseDateiFenster(
    vorbereitung.blobPath,
    teil.startByte,
    teil.endByte,
  );
  if (!bytes || bytes.byteLength === 0) {
    throw new FatalError(
      "Die hochgeladene Datei wurde nicht gefunden. Bitte erneut hochladen.",
    );
  }

  try {
    return await transkribiereMp3Teil(bytes, teil);
  } catch (error) {
    alsAblauffehler(error);
  }
}

async function schreibeAudioChunks(
  docId: string,
  vorbereitung: Vorbereitung,
  teile: TranskriptTeilErgebnis[],
): Promise<{ seiten: number; abschnitte: number }> {
  "use step";

  const { bloecke, seiten } = fuegeTranskripteZusammen(teile);

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
    if (error instanceof QuotaError) throw new FatalError(error.message);
    throw error;
  }

  const { verarbeitung } = vorbereitung;
  const abschnitte = chunkBlocks(bloecke, verarbeitung);

  if (abschnitte.length === 0) {
    throw new FatalError(
      `Aus "${vorbereitung.filename}" liess sich kein gesprochener Text gewinnen. ` +
        `Stille, Musik ohne Sprache oder eine beschaedigte Aufnahme fuehren dazu.`,
    );
  }

  console.log(
    `[ingest ${docId}] Transkript: ${seiten} Seiten, ${abschnitte.length} Abschnitte (${beschreibeVerarbeitung(verarbeitung)})`,
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
    if (/429|ueberlastet|rate limit|timeout|ETIMEDOUT|ECONNRESET/i.test(meldung)) {
      throw new RetryableError(meldung, { retryAfter: "30s" });
    }
    throw new FatalError(meldung);
  }

  return { seiten, abschnitte: abschnitte.length };
}

/** Fuer das Log: Preset und, falls abweichend, die tatsaechlichen Schnittwerte. */
function beschreibeVerarbeitung(verarbeitung: Verarbeitung): string {
  if (!verarbeitung.angepasst) return verarbeitung.label;
  return (
    `${verarbeitung.label}, angepasst: ${verarbeitung.zielGroesse} Zeichen, ` +
    `${verarbeitung.ueberlappung} Ueberlappung`
  );
}

/** So lange darf ein Upload die SQLite-Datei bzw. den Graphen einer Sammlung hoechstens sperren. */
const SPERRE_SEKUNDEN = 120;

/**
 * Seitenpruefung fuer die geschaetzten Seiten einer CSV oder eines Skripts.
 *
 * Als Rueckruf, weil lib/ingest.ts sie zwischen Lesen und Schreiben aufruft:
 * Die Zeilenzahl steht erst nach dem Lesen fest, und geschrieben werden darf
 * erst, wenn sie durch ist.
 */
function seitenpruefung(
  vorbereitung: Vorbereitung,
  seitenBisher: number,
): (seiten: number) => void {
  return (seiten) => {
    try {
      pruefeSeitenzahl(
        { name: vorbereitung.sammlungsName, pageCount: seitenBisher },
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
  };
}

/**
 * Ordnet einen Fehler der Verarbeitung ein: Was sich durch Warten behebt,
 * wird wiederholt; alles andere beendet den Ablauf mit der Meldung.
 */
function alsAblauffehler(error: unknown): never {
  if (error instanceof FatalError || error instanceof RetryableError) throw error;

  const meldung = fehlerMeldung(error);

  // Ungueltige Eingaben und fehlende Konfiguration aendern sich nicht von selbst.
  if (error instanceof ValidationError || error instanceof MissingConfigError) {
    throw new FatalError(meldung);
  }

  if (/429|ueberlastet|rate limit|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Verbindung/i.test(meldung)) {
    throw new RetryableError(meldung, { retryAfter: "30s" });
  }

  throw new FatalError(meldung);
}

async function ladePuffer(vorbereitung: Vorbereitung): Promise<ArrayBuffer> {
  const strom = await leseDatei(vorbereitung.blobPath);
  if (!strom) {
    throw new FatalError(
      "Die hochgeladene Datei wurde nicht gefunden. Bitte erneut hochladen.",
    );
  }
  return new Response(strom).arrayBuffer();
}

/**
 * CSV als Tabelle in die SQLite-Datei der Sammlung schreiben.
 *
 * Die Datei wird als Ganzes gelesen, veraendert und zurueckgeschrieben. Zwei
 * Uploads in dieselbe Sammlung duerfen das nicht gleichzeitig tun — der zweite
 * wuerde die Tabelle des ersten ueberschreiben. Deshalb die Sperre in Redis
 * (SET NX EX): Ist sie belegt, wartet dieser Ablauf und versucht es erneut.
 * Ohne Redis scheitert der Schritt mit klarer Meldung, statt ohne Sperre
 * weiterzulaufen.
 *
 * Eine Datei je Tabelle: Ein frueherer Upload mit demselben Tabellennamen
 * weicht — Datei und Satz — damit die Uebersicht nicht zwei Dateien fuer eine
 * Tabelle zeigt und die Zaehler der Sammlung stimmen. Das geschieht innerhalb
 * derselben Sperre und ist wiederholbar: Ein zweiter Durchlauf findet die
 * Saetze nicht mehr vor.
 */
async function verarbeiteTabelle(
  docId: string,
  vorbereitung: Vorbereitung,
): Promise<{ seiten: number; abschnitte: number }> {
  "use step";

  console.log(`[ingest ${docId}] CSV "${vorbereitung.filename}" als Tabelle`);

  const schluessel = sperrSchluessel(vorbereitung.collectionId);
  await sperreSammlung(schluessel, docId, "Tabellen", "eine andere Tabelle geschrieben");

  try {
    const vorhanden = await ladeDokumenteDerSammlung(
      vorbereitung.userId,
      vorbereitung.collectionId,
    );
    const ersetzt = ersetzteDokumente(vorhanden, vorbereitung.filename, docId);

    // Die Seiten der ersetzten Datei zaehlen fuer die Pruefung nicht mehr mit —
    // sie werden gleich zurueckgebucht.
    const seitenBisher = Math.max(
      vorbereitung.seitenBisher - ersetzt.reduce((summe, satz) => summe + satz.pageCount, 0),
      0,
    );

    const ergebnis = await ingestSql({
      userId: vorbereitung.userId,
      collectionId: vorbereitung.collectionId,
      buffer: await ladePuffer(vorbereitung),
      filename: vorbereitung.filename,
      vorSchreiben: seitenpruefung(vorbereitung, seitenBisher),
    });

    for (const satz of ersetzt) {
      console.log(
        `[ingest ${docId}] ersetzt "${satz.filename}" (Tabelle ${ergebnis.replacedTable})`,
      );
      await loescheDatei(satz.blobPath).catch(() => {
        // Die Datei kann bereits fehlen; der Satz muss trotzdem weichen.
      });
      await entferneDokumentSatz(satz);
    }

    console.log(
      `[ingest ${docId}] ${ergebnis.units} Zeilen in Tabelle ${ergebnis.replacedTable}, ` +
        `${ergebnis.pageCount} Seiten gerechnet`,
    );

    return { seiten: ergebnis.pageCount, abschnitte: ergebnis.units };
  } catch (error) {
    alsAblauffehler(error);
  } finally {
    await gibSperreFrei(schluessel, docId);
  }
}

/**
 * Sperre je Sammlung fuer Schreibvorgaenge, die sich nicht ueberlappen duerfen.
 *
 * Ist sie belegt, wartet dieser Ablauf und versucht es erneut. Ohne Redis
 * scheitert der Schritt mit klarer Meldung, statt ohne Sperre weiterzulaufen —
 * eine Sperre, die nicht sperrt, waere schlimmer als ein Abbruch.
 */
async function sperreSammlung(
  schluessel: string,
  inhaber: string,
  typ: string,
  wasLaeuft: string,
): Promise<void> {
  let gesperrt: boolean;
  try {
    gesperrt = await erwirbSperre(schluessel, inhaber, SPERRE_SEKUNDEN);
  } catch (error) {
    if (error instanceof MissingConfigError) {
      throw new FatalError(
        `${typ}-Sammlungen brauchen Redis fuer die Schreibsperre. ${error.message}`,
      );
    }
    throw new RetryableError(fehlerMeldung(error), { retryAfter: "30s" });
  }

  if (!gesperrt) {
    throw new RetryableError(`In dieser Sammlung wird gerade ${wasLaeuft}.`, {
      retryAfter: "15s",
    });
  }
}

/**
 * Cypher-Skript in den Graphen der Sammlung einspielen.
 *
 * Schlaegt der Import fehl, baut lib/ingest.ts den Graphen aus den uebrigen
 * fertigen Skripten neu auf, bevor der Fehler hier ankommt. Der Zustand ist
 * danach derselbe wie vor dem Schritt — ein Wiederholen ist damit gefahrlos.
 *
 * Dieselbe Sperre wie bei Tabellen: Ein Neuaufbau (nach Fehler oder beim
 * Loeschen eines Skripts) leert den Graphen und spielt die uebrigen Skripte
 * neu ein. Liefe parallel ein Import, wuerde der Neuaufbau ihn wegraeumen —
 * oder ihn als "uebrig" mitzaehlen, obwohl er noch nicht fertig ist.
 */
async function verarbeiteGraph(
  docId: string,
  vorbereitung: Vorbereitung,
): Promise<{ seiten: number; abschnitte: number }> {
  "use step";

  console.log(`[ingest ${docId}] Cypher-Skript "${vorbereitung.filename}" in den Graphen`);

  const schluessel = sperrSchluessel(vorbereitung.collectionId);
  await sperreSammlung(schluessel, docId, "Graph", "ein anderes Skript eingespielt");

  try {
    const vorhanden = await ladeDokumenteDerSammlung(
      vorbereitung.userId,
      vorbereitung.collectionId,
    );
    const uebrige = vorhanden.filter((satz) => satz.id !== docId && satz.status === "fertig");

    const ergebnis = await ingestGraph({
      userId: vorbereitung.userId,
      collectionId: vorbereitung.collectionId,
      buffer: await ladePuffer(vorbereitung),
      uebrige,
      vorSchreiben: seitenpruefung(vorbereitung, vorbereitung.seitenBisher),
    });

    console.log(
      `[ingest ${docId}] ${ergebnis.units} Statements, ${ergebnis.pageCount} Seiten gerechnet`,
    );

    return { seiten: ergebnis.pageCount, abschnitte: ergebnis.units };
  } catch (error) {
    alsAblauffehler(error);
  } finally {
    await gibSperreFrei(schluessel, docId);
  }
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
      model: await modell(DEFAULT_MODEL_ID),
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

    // Je Sammlungstyp ein eigener Schritt; der Weg fuer Dokumente bleibt, wie
    // er war.
    const ergebnis =
      vorbereitung.kind === "sql"
        ? await verarbeiteTabelle(docId, vorbereitung)
        : vorbereitung.kind === "graph"
          ? await verarbeiteGraph(docId, vorbereitung)
          : istMp3(vorbereitung.filename, vorbereitung.contentType)
            ? await verarbeiteAudio(docId, vorbereitung)
            : await extrahiereUndSchreibe(docId, vorbereitung);

    await schliesseAb(docId, vorbereitung, ergebnis);
    await ergaenzeBeschreibung(vorbereitung.collectionId);
  } catch (error) {
    // Der Fehler muss am Dokument landen, sonst steht es bis in alle Ewigkeit
    // auf "laeuft" und der Nutzer erfaehrt nie, woran es lag.
    await vermerkeFehler(docId, fehlerMeldung(error));
    throw error;
  }
}
