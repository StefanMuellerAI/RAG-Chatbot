import { describe, expect, it } from "vitest";
import { Fundstellensammler, baueKontextblock } from "@/lib/ai";
import type { Hit } from "@/lib/vector";

const hit = (docId: string, score: number, text = `Text ${docId}`): Hit => ({
  score, metadata: { docId, filename: `${docId}.pdf`, chunkIndex: 0, text, location: "S. 1" },
});

describe("Fundstellen aus mehreren Sammlungen", () => {
  it("ordnet nach Aehnlichkeit ueber alle Sammlungen, nicht nach Reihenfolge der Sammlungen", () => {
    const sammler = new Fundstellensammler();
    const eintraege = sammler.uebernimm([
      { hit: hit("a", 0.85), sammlungsname: "Erste" },
      { hit: hit("b", 0.95), sammlungsname: "Zweite" },
      { hit: hit("c", 0.9), sammlungsname: "Erste" },
    ]);
    expect(eintraege.map(({ fundstelle }) => [fundstelle.n, fundstelle.collectionName, fundstelle.filename])).toEqual([
      [1, "Zweite", "b.pdf"], [2, "Erste", "c.pdf"], [3, "Erste", "a.pdf"],
    ]);
  });

  it("dedupliziert Abschnitte und haelt das Zeichenbudget ueber Sammlungen hinweg ein", () => {
    const sammler = new Fundstellensammler();
    const lang = "x".repeat(2000);
    const treffer = Array.from({ length: 7 }, (_, i) => ({ hit: hit(`d${i}`, 0.9 - i / 100, lang), sammlungsname: "S" }));
    const eintraege = sammler.uebernimm([...treffer, { hit: hit("d0", 0.99, lang), sammlungsname: "S" }]);
    expect(eintraege).toHaveLength(5);
    expect(eintraege.reduce((summe, { volltext }) => summe + volltext.length, 0)).toBe(10_000);
    expect(new Set(eintraege.map(({ fundstelle }) => fundstelle.documentId)).size).toBe(5);
  });

  it("nennt die Sammlung im Kontextblock nur bei mehreren Sammlungen", () => {
    const sammler = new Fundstellensammler();
    const eintraege = sammler.fuegeHinzu([hit("a", 0.9)], "Handbuch");
    expect(baueKontextblock(eintraege)).toContain("[1] Quelle: a.pdf, S. 1\n");
    expect(baueKontextblock(eintraege)).not.toContain("Sammlung:");
    expect(baueKontextblock(eintraege, true)).toContain("[1] Quelle: a.pdf, S. 1 (Sammlung: Handbuch)");
    expect(baueKontextblock(eintraege, true)).toContain("Auszuege aus den Dokumentensammlungen:");
  });
});
