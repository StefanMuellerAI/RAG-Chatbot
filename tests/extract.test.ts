import { describe, expect, it } from "vitest";
import {
  UnsupportedFileError,
  detectKind,
  extractBlocks,
  istMp3,
} from "@/lib/extract";
import { ValidationError } from "@/lib/errors";

describe("detectKind", () => {
  it("erkennt die bekannten Endungen, auch in Grossbuchstaben", () => {
    expect(detectKind("Bericht.PDF")).toBe("pdf");
    expect(detectKind("Notiz.DOCX")).toBe("docx");
    expect(detectKind("Zahlen.XLSX")).toBe("xlsx");
    expect(detectKind("Sitzung.MP3")).toBe("mp3");
  });

  it("faellt auf den MIME-Typ zurueck, wenn die Endung nicht spricht", () => {
    expect(detectKind("ohneendung", "audio/mpeg")).toBe("mp3");
    expect(detectKind("ohneendung", "audio/mp3")).toBe("mp3");
    expect(detectKind("ohneendung", "application/pdf")).toBe("pdf");
  });

  it("lehnt unbekannte Formate ab", () => {
    expect(() => detectKind("alt.doc")).toThrow(UnsupportedFileError);
    expect(() => detectKind("bild.png")).toThrow(/PDF, DOCX, XLSX und MP3/);
  });
});

describe("istMp3", () => {
  it("ist nur bei MP3 wahr", () => {
    expect(istMp3("ton.mp3")).toBe(true);
    expect(istMp3("bericht.pdf")).toBe(false);
    expect(istMp3("unbekannt.bin")).toBe(false);
  });
});

describe("extractBlocks", () => {
  it("schickt MP3 nicht durch die Dokumentparser", async () => {
    await expect(extractBlocks(new ArrayBuffer(8), "ton.mp3")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
