import type { Quelle } from "./chatVerlauf";

/** Handles split UTF-8 and a final NDJSON record without a trailing newline. */
export async function leseChatStrom(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function parse(line: string) {
    if (!line.trim()) return;
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || !("type" in event)) {
      throw new Error("Die Antwort konnte nicht vollständig gelesen werden.");
    }
    onEvent(event as Record<string, unknown>);
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) parse(line);
      if (done) { parse(buffer); break; }
    }
  } finally { reader.releaseLock(); }
}

/** Only the authenticated document route may be opened from a source. */
export function quellDownload(quelle: Quelle): string | null {
  const path = quelle.downloadUrl;
  if (path && /^\/api\/documents\/[a-zA-Z0-9-]+\/download(?:#[^\s]*)?$/.test(path)) return path;
  if (quelle.documentId && /^[a-zA-Z0-9-]+$/.test(quelle.documentId)) {
    return `/api/documents/${quelle.documentId}/download`;
  }
  return null;
}

export type QuellVorschau =
  | { kind: "pdf"; url: string; page: number | null }
  | { kind: "audio"; url: string; start: number | null; end: number | null };

/** Only extractor-produced positions become browser PDF/media fragments. */
export function quellVorschau(quelle: Quelle): QuellVorschau | null {
  const download = quellDownload(quelle);
  if (!download) return null;
  const base = `${download.split("#", 1)[0]}?inline=1`;
  const ort = quelle.location?.trim() ?? "";
  if (/\.pdf$/i.test(quelle.filename)) {
    const match = /^Seite ([1-9]\d*)$/.exec(ort);
    const page = match ? Number(match[1]) : null;
    const safePage = page !== null && Number.isSafeInteger(page) ? page : null;
    return { kind: "pdf", url: `${base}${safePage ? `#page=${safePage}` : ""}`, page: safePage };
  }
  if (/\.mp3$/i.test(quelle.filename)) {
    const match = /^([\d:]+)–([\d:]+)$/.exec(ort);
    const start = match ? zeitSekunden(match[1]) : null;
    const end = match ? zeitSekunden(match[2]) : null;
    const valid = start !== null && end !== null && end > start;
    return { kind: "audio", url: `${base}${valid ? `#t=${start},${end}` : ""}`,
      start: valid ? start : null, end: valid ? end : null };
  }
  return null;
}

function zeitSekunden(wert: string): number | null {
  if (!/^(?:\d+:)?[0-5]?\d:[0-5]\d$/.test(wert)) return null;
  const parts = wert.split(":").map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** Human-readable position; documents without real anchors keep their download. */
export function quellPositionHinweis(quelle: Quelle): string {
  const ort = quelle.location?.trim() ?? "";
  if (/\.pdf$/i.test(quelle.filename) && /^Seite [1-9]\d*$/.test(ort)) {
    return `${ort} im Originaldokument.`;
  }
  if (/\.mp3$/i.test(quelle.filename) && /^(?:\d+:)?[0-5]?\d:[0-5]\d–(?:\d+:)?[0-5]?\d:[0-5]\d$/.test(ort)) {
    return `Zeitbereich ${ort} der Aufnahme.`;
  }
  if (/^Tabellenblatt ".+"$/.test(ort)) {
    return `Die Fundstelle stammt aus ${ort}. Öffnen Sie dieses Blatt nach dem Herunterladen des Originals.`;
  }
  return "Auszug der Fundstelle. Den vollständigen Zusammenhang finden Sie im Original.";
}

export function zelleAlsText(value: unknown): string {
  if (value == null) return "∅";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(zelleAlsText).join(" → ");
  const record = value as Record<string, unknown>;
  if (record.type === "node") {
    const properties = record.properties as Record<string, unknown> | undefined;
    const name = properties?.name ?? properties?.title ?? properties?.label ?? properties?.id;
    const labels = Array.isArray(record.labels) ? record.labels.join(", ") : "Knoten";
    return name != null ? `${String(name)} (${labels})` : `${labels}: ${JSON.stringify(properties ?? {})}`;
  }
  if (record.type === "edge") return `— ${String(record.relationshipType ?? "Verbindung")} →`;
  return JSON.stringify(value);
}

/** Quoted CSV cells plus formula-injection protection for spreadsheet software. */
export function tabellenCsv(columns: string[], rows: unknown[]): string {
  const escape = (value: unknown) => {
    let text = value == null ? "" : zelleAlsText(value);
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = columns.length ? [columns.map(escape).join(",")] : [];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : columns.map((key) => (row as Record<string, unknown>)?.[key]);
    lines.push(cells.map(escape).join(","));
  }
  return lines.join("\r\n");
}
