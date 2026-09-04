/**
 * Textextraktion aus den unterstuetzten Dokumentformaten.
 *
 * Jede Funktion liefert Bloecke mit optionaler Fundstellenangabe (Seite bzw.
 * Tabellenblatt), damit spaetere Zitate im Chat auf etwas Konkretes zeigen
 * koennen statt nur auf den Dateinamen.
 *
 * Neu gegenueber der einfachen Variante sind zwei Angaben, die beide erst hier
 * zu gewinnen sind:
 *
 *   seiten     — Grundlage der Kontingentpruefung. Die Seitenzahl steht vor der
 *                Extraktion nicht fest: ein 400-seitiges PDF kann als 3-MB-Datei
 *                ankommen und jede Groessenpruefung vorher bestehen.
 *   kopfzeile  — die Spaltenueberschriften eines Tabellenblatts. Ohne sie ist
 *                ein Zahlenblock aus der Mitte einer Tabelle bedeutungslos, und
 *                genau solche Blocks entstehen beim Zerlegen.
 */

import { ValidationError } from "./errors";

export type ExtractedBlock = {
  text: string;
  location?: string;
  /** Spaltenueberschriften; wird beim Tabellen-Preset in jeden Abschnitt wiederholt. */
  kopfzeile?: string;
};

export type Extraktion = {
  bloecke: ExtractedBlock[];
  seiten: number;
};

export const SUPPORTED_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_TYPES;
export type DocumentKind = (typeof SUPPORTED_TYPES)[SupportedMimeType];

export const SUPPORTED_MIME_TYPES = Object.keys(SUPPORTED_TYPES) as SupportedMimeType[];
export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".mp3"];

export class UnsupportedFileError extends Error {
  constructor(filename: string) {
    super(
      `"${filename}" wird nicht unterstuetzt. Moeglich sind PDF, DOCX, XLSX und MP3. ` +
        `Alte Formate (.doc, .xls) bitte einmal in Word bzw. Excel als .docx / .xlsx speichern.`,
    );
    this.name = "UnsupportedFileError";
  }
}

/** Bestimmt das Format primaer ueber die Dateiendung, ersatzweise ueber den MIME-Typ. */
export function detectKind(filename: string, mimeType?: string): DocumentKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".mp3")) return "mp3";

  const byMime = mimeType ? SUPPORTED_TYPES[mimeType as SupportedMimeType] : undefined;
  if (byMime) return byMime;

  throw new UnsupportedFileError(filename);
}

export function istMp3(filename: string, mimeType?: string): boolean {
  try {
    return detectKind(filename, mimeType) === "mp3";
  } catch {
    return false;
  }
}

export async function extractBlocks(
  buffer: ArrayBuffer,
  filename: string,
  mimeType?: string,
): Promise<Extraktion> {
  switch (detectKind(filename, mimeType)) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "xlsx":
      return extractXlsx(buffer);
    case "mp3":
      // Die Transkription laeuft im Ingest-Workflow (lib/transcribe.ts), nicht
      // ueber die lokalen Parser. Wer extractBlocks mit einer MP3 aufruft,
      // hat den falschen Weg genommen.
      throw new ValidationError(
        "MP3-Dateien werden transkribiert, nicht als Dokumenttext gelesen.",
      );
  }
}

async function extractPdf(buffer: ArrayBuffer): Promise<Extraktion> {
  const { extractText } = await import("unpdf");
  // mergePages: false liefert je Seite einen Eintrag — so bleibt die Seitenzahl
  // fuer die spaetere Quellenangabe erhalten.
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: false });

  const bloecke = text
    .map((seitentext, i) => ({ text: normalise(seitentext), location: `Seite ${i + 1}` }))
    .filter((block) => block.text.length > 0);

  // Die Gesamtzahl der Seiten, nicht die der lesbaren: Ein Scan-PDF mit 300
  // Seiten soll auch dann an der Seitengrenze scheitern, wenn keine davon Text
  // enthaelt.
  return { bloecke, seiten: text.length };
}

/**
 * Zeichen, die einer Textseite entsprechen — fuer Formate ohne Seitenbegriff.
 * Exportiert, weil Cypher-Skripte (lib/ingest.ts) nach demselben Mass
 * geschaetzt werden.
 */
export const ZEICHEN_JE_SEITE = 3_000;

async function extractDocx(buffer: ArrayBuffer): Promise<Extraktion> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });

  const text = normalise(value);

  // DOCX kennt keine Seiten — der Umbruch entsteht erst beim Druck. Fuer die
  // Kontingentpruefung braucht es dennoch eine vergleichbare Groesse, deshalb
  // wird gerechnet statt gezaehlt.
  return {
    bloecke: text ? [{ text }] : [],
    seiten: Math.max(Math.ceil(text.length / ZEICHEN_JE_SEITE), text ? 1 : 0),
  };
}

/** Tabellenzeilen, die einer Seite entsprechen. Gilt ebenso fuer CSV-Zeilen. */
export const ZEILEN_JE_SEITE = 50;

async function extractXlsx(buffer: ArrayBuffer): Promise<Extraktion> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const bloecke: ExtractedBlock[] = [];
  let zeilenGesamt = 0;

  workbook.eachSheet((sheet) => {
    const zeilen: string[] = [];

    sheet.eachRow((row) => {
      const zellen: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const wert = cellToText(cell.value);
        if (wert) zellen.push(wert);
      });
      // Zeilen als pipe-getrennte Zeile — behaelt die Spaltenzuordnung
      // erkennbar, ohne den Text mit Formatierung aufzublaehen.
      if (zellen.length > 0) zeilen.push(zellen.join(" | "));
    });

    if (zeilen.length === 0) return;

    zeilenGesamt += zeilen.length;

    // Die erste Zeile gilt als Kopfzeile. Das ist eine Annahme, aber die weit
    // ueberwiegend richtige — und wenn sie falsch ist, kostet sie nur eine
    // zusaetzlich wiederholte Datenzeile je Abschnitt.
    const [kopfzeile, ...rest] = zeilen;
    const inhalt = rest.length > 0 ? rest : zeilen;

    bloecke.push({
      text: inhalt.join("\n"),
      location: `Tabellenblatt "${sheet.name}"`,
      ...(rest.length > 0 ? { kopfzeile } : {}),
    });
  });

  return {
    bloecke,
    seiten: Math.max(Math.ceil(zeilenGesamt / ZEILEN_JE_SEITE), bloecke.length > 0 ? 1 : 0),
  };
}

/** ExcelJS-Zellwerte sind eine Union aus Primitiven, Formeln und Rich-Text. */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if (record.result !== undefined) return cellToText(record.result);
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => cellToText((part as Record<string, unknown>).text))
        .join("")
        .trim();
    }
    if (typeof record.hyperlink === "string") return record.hyperlink;
  }

  return "";
}

function normalise(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
