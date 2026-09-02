import { describe, expect, it } from "vitest";
import { chunkBlocks } from "@/lib/chunk";
import { findPreset } from "@/lib/presets";

/**
 * Die Zerlegung haengt vom Preset der Sammlung ab (lib/presets.ts). Geprueft
 * wird hier vor allem der Fliesstext-Zweig, weil dort die Suche nach der
 * Schnittkante liegt, die bei grossen Bloecken ohne Absaetze quadratisch
 * wurde. Die Strategien selbst deckt zusaetzlich `npm run pruefe:chunks` ab.
 */
const FLIESSTEXT = findPreset("fliesstext");
const TABELLEN = findPreset("tabellen");

/** Simuliert ein Tabellenblatt, wie extractXlsx es liefert: Zeilen per "\n", Zellen per " | ". */
function tabellenText(zeilen: number): string {
  const rows: string[] = [];
  for (let i = 0; i < zeilen; i++) {
    rows.push(`Artikel ${i} | Lager Nord | ${(i * 7) % 1000} Stueck | ${(i % 12) + 1}/2026 | frei`);
  }
  return rows.join("\n");
}

function prosa(saetze: number): string {
  const teile: string[] = [];
  for (let i = 0; i < saetze; i++) {
    teile.push(`Dies ist Satz Nummer ${i} in einem laengeren Fliesstext ueber Verwaltungsablaeufe.`);
    teile.push(i % 6 === 5 ? "\n\n" : " ");
  }
  return teile.join("");
}

describe("chunkBlocks (Fliesstext)", () => {
  it("behaelt kurze, aber vollstaendige Bloecke", () => {
    const text = "Oeffnungszeiten | Mo-Fr | 8-16 Uhr";
    const chunks = chunkBlocks([{ text, location: 'Tabellenblatt "Zeiten"' }], FLIESSTEXT);
    expect(chunks).toEqual([{ text, location: 'Tabellenblatt "Zeiten"' }]);
  });

  it("verwirft Artefakte ohne Substanz", () => {
    expect(
      chunkBlocks([{ text: "12" }, { text: "---- ---- ---- ----" }, { text: "   " }], FLIESSTEXT),
    ).toEqual([]);
  });

  it("schneidet Tabellentext ohne Absaetze an Zeilengrenzen, nie mitten in einer Zeile", () => {
    const chunks = chunkBlocks([{ text: tabellenText(300) }], FLIESSTEXT);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith("frei")).toBe(true);
    }
  });

  it("schneidet Prosa an Satz- oder Absatzgrenzen", () => {
    const chunks = chunkBlocks([{ text: prosa(400) }], FLIESSTEXT);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks.slice(0, -1)) {
      expect(/[.!?;]$/.test(chunk.text)).toBe(true);
    }
  });

  it("ueberlappt aufeinanderfolgende Abschnitte", () => {
    const chunks = chunkBlocks([{ text: prosa(100) }], FLIESSTEXT);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const vorher = chunks[i - 1].text;
      const start = chunks[i].text.slice(0, 40);
      expect(vorher.includes(start.trim().slice(0, 20))).toBe(true);
    }
  });

  it("bleibt bei grossen Tabellen ohne Absaetze linear schnell", () => {
    // Vor der Fensterbegrenzung in findeSchnitt lief `lastIndexOf` ohne
    // Fundstelle bis zum Textanfang zurueck — quadratisches Wachstum.
    const text = tabellenText(10_000);
    const start = performance.now();
    const chunks = chunkBlocks([{ text }], FLIESSTEXT);
    const dauer = performance.now() - start;
    expect(chunks.length).toBeGreaterThan(500);
    expect(dauer).toBeLessThan(300);
  });

  it("verliert keinen Text zwischen den Abschnitten", () => {
    const text = tabellenText(200);
    const chunks = chunkBlocks([{ text }], FLIESSTEXT);
    for (let zeile = 0; zeile < 200; zeile += 37) {
      const marker = `Artikel ${zeile} |`;
      expect(chunks.some((chunk) => chunk.text.includes(marker))).toBe(true);
    }
  });
});

describe("chunkBlocks (Tabellen)", () => {
  it("wiederholt die Kopfzeile in jedem Abschnitt und schneidet an Zeilenenden", () => {
    const kopfzeile = "Artikel | Lager | Menge | Monat | Status";
    const chunks = chunkBlocks(
      [{ text: tabellenText(300), kopfzeile, location: 'Tabellenblatt "Lager"' }],
      TABELLEN,
    );
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith(kopfzeile)).toBe(true);
      expect(chunk.text.endsWith("frei")).toBe(true);
      expect(chunk.location).toBe('Tabellenblatt "Lager"');
    }
  });
});
