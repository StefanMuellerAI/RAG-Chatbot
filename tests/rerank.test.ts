import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hit } from "@/lib/vector";
import { ordneNeu, rerankKonfiguriert, rerankModell, RERANK_STANDARD_MODELL, type Kandidat } from "@/lib/rerank";

/**
 * Der Reranker haengt an einem Fremddienst; hier zaehlt, dass er ohne
 * Konfiguration unsichtbar bleibt, mit Konfiguration die Reihenfolge und den
 * Zuschnitt uebernimmt und bei Ausfall oder Zeitueberschreitung still auf die
 * Kosinus-Reihenfolge zurueckfaellt — nie auf eine fehlende Antwort.
 */
const mocks = vi.hoisted(() => ({
  rerank: vi.fn(),
  konstruktor: vi.fn(),
}));

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: class {
    inference = { rerank: mocks.rerank };
    constructor(options: unknown) { mocks.konstruktor(options); }
  },
}));

const hit = (docId: string, score: number, text = `Text ${docId}`): Hit => ({
  score, metadata: { docId, filename: `${docId}.pdf`, chunkIndex: 0, text, location: "S. 1" },
});
const kandidat = (docId: string, score: number, minRerank = 0.05, sammlungsname = "S"): Kandidat =>
  ({ hit: hit(docId, score), sammlungsname, minRerank });

describe("Reranker", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, PINECONE_API_KEY: "pc-test" };
    mocks.rerank.mockReset();
    mocks.konstruktor.mockReset();
  });
  afterEach(() => {
    process.env = env;
    vi.unstubAllGlobals();
  });

  it("ist ohne RERANK_MODEL aus und leitet die Schaltwerte auf das Standardmodell", () => {
    delete process.env.RERANK_MODEL;
    expect(rerankKonfiguriert()).toBe(false);
    expect(rerankModell()).toBeUndefined();
    process.env.RERANK_MODEL = "an";
    expect(rerankModell()).toBe(RERANK_STANDARD_MODELL);
    process.env.RERANK_MODEL = " 1 ";
    expect(rerankModell()).toBe(RERANK_STANDARD_MODELL);
    process.env.RERANK_MODEL = "cohere-rerank-3.5";
    expect(rerankModell()).toBe("cohere-rerank-3.5");
    expect(rerankKonfiguriert()).toBe(true);
  });

  it("laesst ohne Modell die Kosinus-Reihenfolge, auf hoechstens gekuerzt", async () => {
    delete process.env.RERANK_MODEL;
    const ergebnis = await ordneNeu("Frage", [kandidat("a", 0.8), kandidat("b", 0.9), kandidat("c", 0.85)], { hoechstens: 2 });
    expect(ergebnis.treffer.map((k) => k.hit.metadata.docId)).toEqual(["b", "c"]);
    expect(ergebnis.messung).toMatchObject({ angewendet: false, kandidaten: 3, uebernommen: 2 });
    expect(mocks.rerank).not.toHaveBeenCalled();
  });

  it("ordnet nach dem Rerank-Wert, uebernimmt ihn als score und sortiert unter der Schwelle aus", async () => {
    process.env.RERANK_MODEL = "1";
    mocks.rerank.mockResolvedValue({
      model: RERANK_STANDARD_MODELL,
      data: [{ index: 2, score: 0.91 }, { index: 0, score: 0.4 }, { index: 1, score: 0.01 }],
      usage: { rerankUnits: 1 },
    });
    const ergebnis = await ordneNeu(
      "Wie hoch ist die Gebuehr?",
      [kandidat("a", 0.9, 0.05, "Erste"), kandidat("b", 0.88, 0.05, "Zweite"), kandidat("c", 0.85, 0.05, "Erste")],
      { hoechstens: 3 },
    );
    expect(ergebnis.treffer.map((k) => [k.hit.metadata.docId, k.hit.score, k.sammlungsname])).toEqual([
      ["c", 0.91, "Erste"], ["a", 0.4, "Erste"],
    ]);
    expect(ergebnis.messung).toMatchObject({ angewendet: true, kandidaten: 3, uebernommen: 2 });
    expect(ergebnis.messung.fehler).toBeUndefined();

    const aufruf = mocks.rerank.mock.calls[0][0];
    expect(aufruf).toMatchObject({
      model: RERANK_STANDARD_MODELL, query: "Wie hoch ist die Gebuehr?", topN: 3, returnDocuments: false,
      parameters: { truncate: "END" },
    });
    // Die Dokumente gehen in Kosinus-Reihenfolge hinaus; die Indizes der
    // Antwort beziehen sich auf genau diese Reihenfolge.
    expect(aufruf.documents).toEqual(["Text a", "Text b", "Text c"]);
    expect(mocks.konstruktor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "pc-test", maxRetries: 0 }));
  });

  it("wendet die Schwelle je Sammlung an und begrenzt die Kandidaten", async () => {
    process.env.RERANK_MODEL = "1";
    const viele = Array.from({ length: 60 }, (_, i) => kandidat(`d${i}`, 1 - i / 100, i % 2 === 0 ? 0.5 : 0.05));
    mocks.rerank.mockImplementation(async ({ documents }: { documents: string[] }) => ({
      model: RERANK_STANDARD_MODELL, usage: { rerankUnits: 1 },
      data: documents.map((_, index) => ({ index, score: 0.3 })).slice(0, 4),
    }));
    const ergebnis = await ordneNeu("Frage", viele, { hoechstens: 4 });
    expect(mocks.rerank.mock.calls[0][0].documents).toHaveLength(50);
    // d0 und d2 verlangen 0,5 und fallen bei 0,3 heraus; d1 und d3 bleiben.
    expect(ergebnis.treffer.map((k) => k.hit.metadata.docId)).toEqual(["d1", "d3"]);
    expect(ergebnis.messung).toMatchObject({ angewendet: true, kandidaten: 50, uebernommen: 2 });
  });

  it("kuerzt lange Abschnitte fuer das Modell, laesst den Treffer aber ganz", async () => {
    process.env.RERANK_MODEL = "1";
    const lang = "x".repeat(5_000);
    mocks.rerank.mockResolvedValue({ model: "m", data: [{ index: 0, score: 0.7 }], usage: { rerankUnits: 1 } });
    const ergebnis = await ordneNeu("Frage", [{ hit: hit("a", 0.9, lang), sammlungsname: "S", minRerank: 0 }], { hoechstens: 1 });
    expect(mocks.rerank.mock.calls[0][0].documents[0]).toHaveLength(2_000);
    expect(ergebnis.treffer[0].hit.metadata.text).toHaveLength(5_000);
  });

  it("faellt bei einem Fehler des Dienstes auf die Kosinus-Reihenfolge zurueck und meldet ihn", async () => {
    process.env.RERANK_MODEL = "1";
    mocks.rerank.mockRejectedValue(new Error("429 Too Many Requests"));
    const ergebnis = await ordneNeu("Frage", [kandidat("a", 0.8), kandidat("b", 0.9)], { hoechstens: 5 });
    expect(ergebnis.treffer.map((k) => [k.hit.metadata.docId, k.hit.score])).toEqual([["b", 0.9], ["a", 0.8]]);
    expect(ergebnis.messung).toMatchObject({ angewendet: false, kandidaten: 2, uebernommen: 2, fehler: "429 Too Many Requests" });
  });

  it("bricht nach dem Zeitlimit ab und antwortet trotzdem", async () => {
    process.env.RERANK_MODEL = "1";
    // Der Dienst antwortet nie; nur das Signal, das ordneNeu dem fetch
    // mitgibt, beendet den Aufruf.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    mocks.rerank.mockImplementation(async () => {
      const { fetchApi } = mocks.konstruktor.mock.calls[0][0] as { fetchApi: typeof fetch };
      await fetchApi("https://api.pinecone.io/rerank", { method: "POST" });
      return { model: "m", data: [], usage: { rerankUnits: 1 } };
    });
    const ergebnis = await ordneNeu("Frage", [kandidat("a", 0.8), kandidat("b", 0.9)], { hoechstens: 5, zeitlimitMs: 20 });
    expect(ergebnis.treffer.map((k) => k.hit.metadata.docId)).toEqual(["b", "a"]);
    expect(ergebnis.messung.angewendet).toBe(false);
    expect(ergebnis.messung.fehler).toMatch(/timed out|TimeoutError|abort/i);
  });

  it("reicht einen Abbruch durch den Nutzer nach oben durch", async () => {
    process.env.RERANK_MODEL = "1";
    const abbruch = new AbortController();
    mocks.rerank.mockImplementation(async () => { abbruch.abort(new Error("Nutzer weg")); throw new Error("abgebrochen"); });
    await expect(ordneNeu("Frage", [kandidat("a", 0.8)], { hoechstens: 5, signal: abbruch.signal })).rejects.toThrow("abgebrochen");
  });

  it("ruft den Dienst ohne Kandidaten gar nicht erst auf", async () => {
    process.env.RERANK_MODEL = "1";
    const ergebnis = await ordneNeu("Frage", [], { hoechstens: 5 });
    expect(ergebnis.treffer).toEqual([]);
    expect(mocks.rerank).not.toHaveBeenCalled();
  });
});
