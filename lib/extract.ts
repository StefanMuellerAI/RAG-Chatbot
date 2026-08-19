/**
 * Textextraktion aus den unterstuetzten Dokumentformaten.
 *
 * Jede Funktion liefert Bloecke mit optionaler Fundstellenangabe (Seite bzw.
 * Tabellenblatt), damit spaetere Zitate im Chat auf etwas Konkretes zeigen
 * koennen statt nur auf den Dateinamen.
 */

export type ExtractedBlock = { text: string; location?: string };

export const SUPPORTED_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_TYPES;

export const SUPPORTED_MIME_TYPES = Object.keys(SUPPORTED_TYPES) as SupportedMimeType[];
export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx"];

export class UnsupportedFileError extends Error {
  constructor(filename: string) {
    super(
      `"${filename}" wird nicht unterstuetzt. Moeglich sind PDF, DOCX und XLSX. ` +
        `Alte Formate (.doc, .xls) bitte einmal in Word bzw. Excel als .docx / .xlsx speichern.`,
    );
    this.name = "UnsupportedFileError";
  }
}

/** Bestimmt das Format primaer ueber die Dateiendung, ersatzweise ueber den MIME-Typ. */
export function detectKind(filename: string, mimeType?: string): "pdf" | "docx" | "xlsx" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";

  const byMime = mimeType ? SUPPORTED_TYPES[mimeType as SupportedMimeType] : undefined;
  if (byMime) return byMime;

  throw new UnsupportedFileError(filename);
}

export async function extractBlocks(
  buffer: ArrayBuffer,
  filename: string,
  mimeType?: string,
): Promise<ExtractedBlock[]> {
  switch (detectKind(filename, mimeType)) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "xlsx":
      return extractXlsx(buffer);
  }
}

async function extractPdf(buffer: ArrayBuffer): Promise<ExtractedBlock[]> {
  const { extractText } = await import("unpdf");
  // mergePages: false liefert je Seite einen Eintrag — so bleibt die
  // Seitenzahl fuer die spaetere Quellenangabe erhalten.
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: false });

  return text
    .map((pageText, i) => ({ text: normalise(pageText), location: `Seite ${i + 1}` }))
    .filter((block) => block.text.length > 0);
}

async function extractDocx(buffer: ArrayBuffer): Promise<ExtractedBlock[]> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });

  const text = normalise(value);
  return text ? [{ text }] : [];
}

async function extractXlsx(buffer: ArrayBuffer): Promise<ExtractedBlock[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const blocks: ExtractedBlock[] = [];

  workbook.eachSheet((sheet) => {
    const rows: string[] = [];

    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cellToText(cell.value);
        if (value) cells.push(value);
      });
      // Zeilen als Pipe-getrennte Zeile — behaelt die Spaltenzuordnung
      // erkennbar, ohne den Text mit Formatierung aufzublaehen.
      if (cells.length > 0) rows.push(cells.join(" | "));
    });

    if (rows.length > 0) {
      blocks.push({ text: rows.join("\n"), location: `Tabellenblatt "${sheet.name}"` });
    }
  });

  return blocks;
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
