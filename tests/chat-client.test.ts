import { describe, expect, it } from "vitest";
import { leseChatStrom, quellDownload, quellPositionHinweis, quellVorschau, tabellenCsv, zelleAlsText } from "@/lib/chat-client";

function stream(bytes: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of bytes) controller.enqueue(part);
    controller.close();
  } });
}

describe("chat stream recovery", () => {
  it("reads arbitrary UTF-8 splits and the last record without a newline", async () => {
    const bytes = new TextEncoder().encode('{"type":"text","delta":"Grüße"}\n{"type":"done","status":"completed"}');
    const events: Record<string, unknown>[] = [];
    await leseChatStrom(stream([...bytes].map((byte) => new Uint8Array([byte]))), (event) => events.push(event));
    expect(events).toEqual([{ type: "text", delta: "Grüße" }, { type: "done", status: "completed" }]);
  });
  it("reports a broken record after delivering the usable partial answer", async () => {
    const events: Record<string, unknown>[] = [];
    const bytes = new TextEncoder().encode('{"type":"text","delta":"Erster Satz."}\n{"type":');
    await expect(leseChatStrom(stream([bytes]), (event) => events.push(event))).rejects.toThrow();
    expect(events).toEqual([{ type: "text", delta: "Erster Satz." }]);
  });
});

describe("source navigation and result export", () => {
  const source = { n: 1, filename: "Handbuch.pdf", location: "Seite 4", score: 0.8, snippet: "Auszug" };
  it("opens only the authenticated document route, including for historical sources", () => {
    expect(quellDownload({ ...source, downloadUrl: "/api/documents/abc-123/download" })).toBe("/api/documents/abc-123/download");
    expect(quellDownload({ ...source, documentId: "abc-123" })).toBe("/api/documents/abc-123/download");
    for (const downloadUrl of ["javascript:alert(1)", "//example.org/file", "/api/documents/../secret/download", "https://example.org/file"]) {
      expect(quellDownload({ ...source, downloadUrl })).toBeNull();
    }
    expect(quellDownload(source)).toBeNull();
  });
  it("quotes commas/newlines and neutralizes spreadsheet formulas in headers and cells", () => {
    const csv = tabellenCsv(["Name", "=sum(A1)"], [["Müller, Anna", '=HYPERLINK("https://evil")'], ["Zeile\n2", " @SUM(1)"]]);
    expect(csv).toContain('"\'=sum(A1)"');
    expect(csv).toContain('"Müller, Anna"');
    expect(csv).toContain('"\'=HYPERLINK(""https://evil"")"');
    expect(csv).toContain('"Zeile\n2"');
    expect(csv).toContain('"\' @SUM(1)"');
  });
  it("describes real source positions without inventing unsupported section links", () => {
    expect(quellPositionHinweis(source)).toContain("Seite 4 im Originaldokument");
    expect(quellPositionHinweis({ ...source, filename: "Interview.mp3", location: "1:03:20–1:04:10" })).toContain("Zeitbereich 1:03:20–1:04:10");
    expect(quellPositionHinweis({ ...source, filename: "Plan.xlsx", location: 'Tabellenblatt "Umsatz"' })).toContain('Tabellenblatt "Umsatz"');
    expect(quellPositionHinweis({ ...source, filename: "Text.docx", location: null })).toContain("vollständigen Zusammenhang");
    expect(quellPositionHinweis({ ...source, filename: "Interview.mp3", location: "Transkription" })).not.toContain("Zeitbereich");
    expect(quellPositionHinweis({ ...source, filename: "Interview.mp3", location: "1:99–2:10" })).not.toContain("Zeitbereich");
  });
  it("links PDF pages and audio time spans only when their metadata is valid", () => {
    const local = { ...source, documentId: "document-1" };
    expect(quellVorschau(local)).toEqual({ kind: "pdf", url: "/api/documents/document-1/download?inline=1#page=4", page: 4 });
    expect(quellVorschau({ ...local, filename: "Interview.mp3", location: "1:03:20–1:04:10" }))
      .toEqual({ kind: "audio", url: "/api/documents/document-1/download?inline=1#t=3800,3850", start: 3800, end: 3850 });
    for (const location of ["Transkription", "1:99–2:10", "2:10–1:10"]) {
      expect(quellVorschau({ ...local, filename: "Interview.mp3", location })?.url).toBe("/api/documents/document-1/download?inline=1");
    }
    expect(quellVorschau({ ...local, location: "Seite 0" })?.url).not.toContain("#page");
    expect(quellVorschau({ ...local, filename: "Text.docx", location: "Einleitung" })).toBeNull();
    expect(quellVorschau(source)).toBeNull();
  });
  it("turns available graph path nodes into readable names and relationships", () => {
    expect(zelleAlsText([
      { type: "node", labels: ["Person"], properties: { name: "Anna" } },
      { type: "edge", relationshipType: "ARBEITET_BEI" },
      { type: "node", labels: ["Firma"], properties: { name: "Acme" } },
    ])).toContain("Anna (Person)");
    expect(zelleAlsText({ type: "edge", relationshipType: "ARBEITET_BEI" })).toContain("ARBEITET_BEI");
  });
});
