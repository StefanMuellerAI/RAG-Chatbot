import { Pinecone } from "@pinecone-database/pinecone";
import { checkIngestionCapacity, ingestionSignal } from "./capacity";
import { requireEnv } from "./env";
import { fehlerMeldung } from "./errors";
import { STANDARD_MIN_SCORE } from "./presets";

/**
 * Vektorsuche ueber Pinecone Serverless — ein Namespace je Sammlung.
 *
 * Warum Namespaces und nicht ein Filter auf einem Metadatenfeld: Bei Pinecone
 * richten sich die Abfragekosten nach der Groesse des angefragten Namespace
 * (1 RU je GB, mindestens 0,25 RU). Eine Abfrage in einer kleinen Sammlung
 * kostet damit das Minimum, egal wie viele Sammlungen es insgesamt gibt. Ein
 * Metadatenfilter ueber einen gemeinsamen Namespace wuerde dagegen bei jeder
 * Abfrage den gesamten Bestand abrechnen, denn gefiltert wird nach dem
 * Durchsuchen. Bei 15.000 Nutzern ist das der Unterschied zwischen einer
 * zweistelligen und einer fuenfstelligen Monatsrechnung.
 *
 * Zweiter Grund: Namespaces sind harte Trennwaende. Eine Abfrage erreicht
 * genau einen Namespace. Ein vergessener Filter koennte fremde Dokumente
 * offenlegen, ein falscher Namespace liefert schlicht nichts.
 *
 * Das Einbetten uebernimmt Pinecone selbst ("Integrated Inference") mit
 * multilingual-e5-large. Damit bleibt es bei einem Dienst fuer Speichern und
 * Einbetten, so wie es vorher mit Upstash war, und es braucht keinen zweiten
 * Anbieter fuer die Vektoren.
 */

/** Name des Feldes, das eingebettet wird. Muss zur fieldMap des Index passen. */
export const TEXT_FELD = "chunk_text";

export const EMBEDDING_MODELL = "multilingual-e5-large";

/**
 * Aehnlichkeitsschwelle, sofern eine Sammlung keine eigene setzt.
 *
 * Der Wert und seine Kalibrierung stehen in lib/presets.ts, weil das
 * Anlegeformular ihn als Vorgabe zeigt. Hier bleibt er unter dem alten Namen
 * erreichbar, damit bestehende Aufrufer und Test-Mocks weiterlaufen.
 */
export const MIN_SCORE = STANDARD_MIN_SCORE;

export type ChunkMetadata = {
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  /** Seitenzahl bzw. Tabellenblatt, sofern das Format so etwas kennt. */
  location?: string;
};

export type Hit = {
  score: number;
  metadata: ChunkMetadata;
};

/**
 * Der Namespace einer Sammlung.
 *
 * Deterministisch aus der Sammlungs-ID. Dadurch braucht es keine zweite
 * Zuordnungstabelle, und eine geloeschte Sammlung laesst sich restlos
 * entfernen, ohne dass irgendwo eine Namensliste mitgefuehrt werden muss.
 */
export function namespaceFuer(collectionId: string): string {
  return `col_${collectionId}`;
}

/** Erst im Request-Handler aufrufen, niemals auf Modulebene. */
function getIndex(signal?: AbortSignal) {
  const env = requireEnv("PINECONE_API_KEY", "PINECONE_INDEX");
  const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY, maxRetries: 0,
    ...(signal ? { fetchApi: (url, init) => fetch(url, { ...init, signal }) } : {}),
  });
  return pinecone.index(env.PINECONE_INDEX);
}

/**
 * Chunk-IDs sind bewusst deterministisch praefixiert (`<docId>#<n>`).
 * Ein komplettes Dokument laesst sich damit ohne mitgefuehrte ID-Liste
 * entfernen.
 */
function chunkId(docId: string, index: number): string {
  return `${docId}#${index}`;
}

/**
 * Obergrenze je Schreibvorgang.
 *
 * Bei Integrated Inference bettet Pinecone serverseitig ein, und zu grosse
 * Stapel laufen in Zeitueberschreitungen. 90 hat sich als vertraeglich
 * erwiesen und laesst Luft zum harten Limit.
 */
const UPSERT_BATCH_SIZE = 90;

export type UpsertChunk = { text: string; location?: string };

/** Schreibt die Abschnitte eines Dokuments in den Namespace einer Sammlung. */
export async function upsertChunks(
  collectionId: string,
  docId: string,
  filename: string,
  chunks: UpsertChunk[],
  startIndex = 0,
): Promise<void> {
  checkIngestionCapacity();
  const namespace = getIndex(ingestionSignal()).namespace(namespaceFuer(collectionId));

  for (let offset = 0; offset < chunks.length; offset += UPSERT_BATCH_SIZE) {
    checkIngestionCapacity();
    const stapel = chunks.slice(offset, offset + UPSERT_BATCH_SIZE).map((chunk, i) => {
      const nummer = startIndex + offset + i;
      return {
        _id: chunkId(docId, nummer),
        [TEXT_FELD]: chunk.text,
        docId,
        filename,
        chunkIndex: nummer,
        ...(chunk.location ? { location: chunk.location } : {}),
      };
    });

    try {
      await namespace.upsertRecords({ records: stapel });
    } catch (error) {
      throw new Error(erklaerePineconeFehler(error), { cause: error });
    }
  }
}

/** Sucht die relevantesten Abschnitte in EINER Sammlung. */
export async function sucheInSammlung(
  collectionId: string,
  frage: string,
  topK: number,
  signal?: AbortSignal,
): Promise<Hit[]> {
  signal?.throwIfAborted();
  const namespace = getIndex(signal).namespace(namespaceFuer(collectionId));

  let antwort;
  try {
    antwort = await namespace.searchRecords({
      query: { topK, inputs: { text: frage } },
      fields: [TEXT_FELD, "docId", "filename", "chunkIndex", "location"],
    });
  } catch (error) {
    // Ein Namespace, in den noch nichts geschrieben wurde, existiert bei
    // Pinecone nicht. Eine frisch angelegte, leere Sammlung ist ein normaler
    // Zustand und kein Fehler — sie liefert einfach keine Treffer.
    if (istUnbekannterNamespace(error)) return [];
    throw new Error(erklaerePineconeFehler(error), { cause: error });
  }

  const treffer: Hit[] = [];

  for (const eintrag of antwort.result.hits) {
    const felder = eintrag.fields as Record<string, unknown>;
    const text = typeof felder[TEXT_FELD] === "string" ? felder[TEXT_FELD] : "";

    // Ein Abschnitt ohne Wortlaut kann keine Antwort stuetzen und wuerde im
    // Kontextblock nur einen leeren Platz belegen.
    if (!text) continue;

    treffer.push({
      score: eintrag._score,
      metadata: {
        docId: String(felder.docId ?? ""),
        filename: String(felder.filename ?? "Unbekannte Datei"),
        chunkIndex: Number(felder.chunkIndex ?? 0),
        text,
        ...(typeof felder.location === "string" ? { location: felder.location } : {}),
      },
    });
  }

  return treffer;
}

/** Entfernt alle Abschnitte eines einzelnen Dokuments. */
export async function loescheDokumentChunks(
  collectionId: string,
  docId: string,
  chunkCount: number,
): Promise<void> {
  if (chunkCount <= 0) return;

  const namespace = getIndex().namespace(namespaceFuer(collectionId));

  // Pinecone kennt kein Praefix-Delete. Weil die IDs aber deterministisch sind,
  // lassen sie sich aus docId und Abschnittszahl rekonstruieren, ohne dass eine
  // ID-Liste mitgefuehrt werden muesste.
  const ids = Array.from({ length: chunkCount }, (_, i) => chunkId(docId, i));

  // Das Limit fuer deleteMany liegt bei 1000 IDs je Aufruf.
  for (let offset = 0; offset < ids.length; offset += 1000) {
    try {
      await namespace.deleteMany({ ids: ids.slice(offset, offset + 1000) });
    } catch (error) {
      if (istUnbekannterNamespace(error)) return;
      throw new Error(erklaerePineconeFehler(error), { cause: error });
    }
  }
}

/** Entfernt den kompletten Namespace einer Sammlung. */
export async function loescheSammlung(collectionId: string): Promise<void> {
  try {
    await getIndex().deleteNamespace(namespaceFuer(collectionId));
  } catch (error) {
    // Nie beschrieben, also nichts zu loeschen.
    if (istUnbekannterNamespace(error)) return;
    throw new Error(erklaerePineconeFehler(error), { cause: error });
  }
}

/** Anzahl der Vektoren in einer Sammlung — fuer die Anzeige und Pruefzwecke. */
export async function zaehleVektoren(collectionId: string): Promise<number> {
  try {
    const statistik = await getIndex().describeIndexStats();
    return statistik.namespaces?.[namespaceFuer(collectionId)]?.recordCount ?? 0;
  } catch {
    return 0;
  }
}

function istUnbekannterNamespace(error: unknown): boolean {
  const meldung = fehlerMeldung(error);
  // Ein 404 auf /indexes/... ist ein fehlender Index, kein leerer Namespace.
  if (/\/indexes\//i.test(meldung)) return false;
  return /namespace not found|not found.*namespace|404/i.test(meldung);
}

/**
 * Der haeufigste Einrichtungsfehler ist ein Index, der ohne eingebautes
 * Embedding-Modell angelegt wurde. Pinecone antwortet darauf mit einer
 * generischen Meldung — hier wird daraus ein verwertbarer Hinweis.
 */
function erklaerePineconeFehler(error: unknown): string {
  const meldung = fehlerMeldung(error);

  if (/HTTP status 404/i.test(meldung) && /\/indexes\//i.test(meldung)) {
    return (
      `Der Pinecone-Index existiert nicht (${meldung}). ` +
      `Die Anwendung braucht einen Index mit eingebautem Embedding-Modell. ` +
      `Bitte einmal "npm run pinecone:init" ausfuehren; das legt einen Index mit ` +
      `dem Modell "${EMBEDDING_MODELL}" und dem Textfeld "${TEXT_FELD}" an.`
    );
  }

  if (/embed|field_map|fieldMap|integrated|dimension/i.test(meldung)) {
    return (
      `Der Pinecone-Index nimmt keinen Rohtext entgegen (${meldung}). ` +
      `Sehr wahrscheinlich wurde er ohne eingebautes Embedding-Modell angelegt. ` +
      `Bitte einmal "npm run pinecone:init" ausfuehren; das legt einen Index mit ` +
      `dem Modell "${EMBEDDING_MODELL}" und dem Textfeld "${TEXT_FELD}" an.`
    );
  }

  if (/429|rate limit|too many requests/i.test(meldung)) {
    return `Die Vektor-Datenbank ist derzeit ueberlastet (${meldung}).`;
  }

  return `Zugriff auf die Vektor-Datenbank fehlgeschlagen: ${meldung}`;
}
