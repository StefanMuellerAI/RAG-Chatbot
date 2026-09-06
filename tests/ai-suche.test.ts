import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SammlungMitKlasse } from "@/lib/collections";
import type { Hit } from "@/lib/vector";

const mocks = vi.hoisted(() => ({
  suche: vi.fn(),
  ordneNeu: vi.fn(),
  konfiguriert: vi.fn(() => false),
}));
vi.mock("@/lib/vector", () => ({ sucheInSammlung: mocks.suche }));
vi.mock("@/lib/rerank", () => ({ ordneNeu: mocks.ordneNeu, rerankKonfiguriert: mocks.konfiguriert }));
vi.mock("@/lib/capacity", () => ({ withCapacity: (_art: string, arbeit: () => Promise<unknown>) => arbeit() }));

import { Fundstellensammler, baueKontextblock, rerankAktiv, sammleTreffer, sucheMitSchwelle } from "@/lib/ai";

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

const sammlung = (id: string, processing: Record<string, unknown> | null = null): SammlungMitKlasse =>
  ({ id, name: `Sammlung ${id}`, kind: "vector", userId: "u1", preset: "fliesstext", processing }) as unknown as SammlungMitKlasse;

describe("Gemeinsamer Suchweg mit und ohne Reranker", () => {
  beforeEach(() => {
    mocks.suche.mockReset();
    mocks.ordneNeu.mockReset();
    mocks.konfiguriert.mockReturnValue(false);
  });

  it("sucht ohne Reranker mit dem topK des Presets und der Kosinus-Schwelle", async () => {
    mocks.suche.mockResolvedValue([hit("a", 0.9), hit("b", 0.81)]);
    const treffer = await sucheMitSchwelle(sammlung("s1", { topK: 4, minScore: 0.85 }), "Frage");
    expect(mocks.suche).toHaveBeenCalledWith("s1", "Frage", 4, undefined);
    expect(treffer.map((t) => t.metadata.docId)).toEqual(["a"]);
  });

  it("sucht mit Reranker breiter und laesst die Schwelle etwas tiefer", async () => {
    mocks.suche.mockResolvedValue([hit("a", 0.9), hit("b", 0.81), hit("c", 0.7)]);
    const treffer = await sucheMitSchwelle(sammlung("s1", { topK: 4, minScore: 0.85 }), "Frage", undefined, { rerank: true });
    expect(mocks.suche).toHaveBeenCalledWith("s1", "Frage", 8, undefined);
    expect(treffer.map((t) => t.metadata.docId)).toEqual(["a", "b"]);
    await sucheMitSchwelle(sammlung("s2", { topK: 30 }), "Frage", undefined, { rerank: true });
    expect(mocks.suche).toHaveBeenLastCalledWith("s2", "Frage", 30, undefined);
  });

  it("greift nur, wenn er konfiguriert ist und keine Sammlung ihn abgeschaltet hat", () => {
    expect(rerankAktiv([sammlung("a")])).toBe(false);
    mocks.konfiguriert.mockReturnValue(true);
    expect(rerankAktiv([])).toBe(false);
    expect(rerankAktiv([sammlung("a"), sammlung("b")])).toBe(true);
    expect(rerankAktiv([sammlung("a"), sammlung("b", { rerank: false })])).toBe(false);
  });

  it("liefert ohne Reranker die Kandidaten aller Sammlungen mit ihrer Schwelle, ohne den Dienst zu rufen", async () => {
    mocks.suche.mockImplementation(async (id: string) => [hit(`${id}-1`, 0.9)]);
    const treffer = await sammleTreffer([sammlung("a"), sammlung("b", { minRerank: 0.3 })], "Frage");
    expect(treffer.map((k) => [k.hit.metadata.docId, k.sammlungsname, k.minRerank])).toEqual([
      ["a-1", "Sammlung a", 0.05], ["b-1", "Sammlung b", 0.3],
    ]);
    expect(mocks.ordneNeu).not.toHaveBeenCalled();
  });

  it("gibt mit Reranker alle Kandidaten in einem Zug an den Dienst und meldet die Messung", async () => {
    mocks.konfiguriert.mockReturnValue(true);
    mocks.suche.mockImplementation(async (id: string) => [hit(`${id}-1`, 0.9), hit(`${id}-2`, 0.8)]);
    const messung = { angewendet: true, dauerMs: 12, kandidaten: 4, uebernommen: 1 };
    mocks.ordneNeu.mockImplementation(async (_frage: string, kandidaten: { hit: Hit }[]) => ({
      treffer: [{ ...kandidaten[3], hit: { ...kandidaten[3].hit, score: 0.77 } }], messung,
    }));
    const gemeldet: unknown[] = [];
    const signal = new AbortController().signal;
    const treffer = await sammleTreffer(
      [sammlung("a", { topK: 6 }), sammlung("b", { topK: 30 })], "Frage", { signal, onRerank: (m) => gemeldet.push(m) },
    );
    expect(mocks.suche).toHaveBeenCalledWith("a", "Frage", 12, signal);
    expect(mocks.suche).toHaveBeenCalledWith("b", "Frage", 30, signal);
    expect(mocks.ordneNeu).toHaveBeenCalledTimes(1);
    const [frage, kandidaten, optionen] = mocks.ordneNeu.mock.calls[0];
    expect(frage).toBe("Frage");
    expect(kandidaten).toHaveLength(4);
    // 6 + 30 Treffer waeren erlaubt; mehr als 20 Belege nimmt der Sammler ohnehin nicht.
    expect(optionen).toEqual({ hoechstens: 20, signal });
    expect(treffer.map((k) => [k.hit.metadata.docId, k.hit.score])).toEqual([["b-2", 0.77]]);
    expect(gemeldet).toEqual([messung]);
  });

  it("uebernimmt die Rerank-Werte in die Fundstellen, damit der Sammler danach ordnet", async () => {
    mocks.konfiguriert.mockReturnValue(true);
    mocks.suche.mockResolvedValue([hit("a", 0.95), hit("b", 0.9)]);
    mocks.ordneNeu.mockImplementation(async (_frage: string, kandidaten: { hit: Hit }[]) => ({
      treffer: [
        { ...kandidaten[1], hit: { ...kandidaten[1].hit, score: 0.8 } },
        { ...kandidaten[0], hit: { ...kandidaten[0].hit, score: 0.2 } },
      ],
      messung: { angewendet: true, dauerMs: 1, kandidaten: 2, uebernommen: 2 },
    }));
    const sammler = new Fundstellensammler();
    const eintraege = sammler.uebernimm(await sammleTreffer([sammlung("s")], "Frage"));
    expect(eintraege.map(({ fundstelle }) => [fundstelle.n, fundstelle.filename, fundstelle.score])).toEqual([
      [1, "b.pdf", 0.8], [2, "a.pdf", 0.2],
    ]);
  });
});
