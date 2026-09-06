import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "@/lib/db/schema";
import type { GraphDaten } from "@/lib/graph-extraktion";

/**
 * Der Weg eines Dokuments in eine Graph-Sammlung: Text gewinnen, Abschnitte
 * als Artefakt ablegen, je Abschnitt ein Modellaufruf hinter der
 * Budgetreservierung, Ergebnis zusammenfuehren, `_graph.json` schreiben und
 * unter der Sammlungssperre einspielen. Modell, Speicher und Graph sind
 * gemockt; geprueft wird die Reihenfolge und was wohin geschrieben wird.
 */
const mocks = vi.hoisted(() => ({
  dateien: new Map<string, string>(),
  generateText: vi.fn(), reserveModelCall: vi.fn(),
  extractBlocks: vi.fn(),
  list: vi.fn(), finish: vi.fn(), acquire: vi.fn(), release: vi.fn(),
  importGraphDaten: vi.fn(), deleteGraph: vi.fn(), importStatements: vi.fn(),
  setSchema: vi.fn(), verbucheExtraktion: vi.fn(),
}));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: mocks.generateText }));
vi.mock("@/lib/ai", async (original) => ({ ...await original<typeof import("@/lib/ai")>(), modell: async () => "test/model" }));
vi.mock("@/lib/capacity", async (original) => ({
  ...await original<typeof import("@/lib/capacity")>(),
  reserveModelCall: mocks.reserveModelCall,
  checkIngestionCapacity: () => undefined,
  withIngestionCapacity: async (work: (context: { signal: AbortSignal }) => Promise<unknown>) => work({ signal: new AbortController().signal }),
  protectIngestionLock: (key: string, owner: string) => async () => { await mocks.release(key, owner); },
}));
vi.mock("@/lib/documents", async (original) => ({
  ...await original<typeof import("@/lib/documents")>(),
  leseDatei: async (pfad: string) => {
    const inhalt = mocks.dateien.get(pfad);
    return inhalt === undefined ? null : new Blob([inhalt]).stream();
  },
  schreibeDatei: async (pfad: string, inhalt: string) => { mocks.dateien.set(pfad, inhalt); },
  ladeDokumenteDerSammlung: mocks.list,
  schliesseDokumentAb: mocks.finish,
}));
vi.mock("@/lib/extract", async (original) => ({ ...await original<typeof import("@/lib/extract")>(), extractBlocks: mocks.extractBlocks }));
vi.mock("@/lib/ratelimit", async (original) => ({
  ...await original<typeof import("@/lib/ratelimit")>(), erwirbSperre: mocks.acquire, gibSperreFrei: mocks.release,
}));
vi.mock("@/lib/graphstore", () => ({
  importGraphDaten: mocks.importGraphDaten, deleteGraph: mocks.deleteGraph, importStatements: mocks.importStatements,
  describeGraph: async () => ({ kind: "graph", nodes: 3, relationships: 1, labels: ["Person", "Quelle"], relationshipTypes: [], propertyKeys: [] }),
}));
vi.mock("@/lib/collections", async (original) => ({ ...await original<typeof import("@/lib/collections")>(), setzeSammlungsSchema: mocks.setSchema }));
vi.mock("@/lib/verbrauch", () => ({ verbucheExtraktion: mocks.verbucheExtraktion, verbucheIngestion: vi.fn() }));
vi.mock("workflow", async (original) => ({ ...await original<typeof import("workflow")>(), getStepMetadata: () => ({ stepId: "step-7" }) }));

import { STANDARD_ONTOLOGIE } from "@/lib/graph-ontologie";
import { verarbeiteGraphDokument } from "@/workflows/ingest";

const prep = {
  userId: "user_a", collectionId: "collection_a", filename: "bericht.pdf",
  contentType: "application/pdf", blobPath: "files/user_a/collection_a/doc-1/bericht.pdf", kind: "graph" as const,
  verarbeitung: { label: "test", angepasst: false, zielGroesse: 1000, ueberlappung: 100 },
  sizeClassId: "test", maxPagesPerDocument: 100, maxTotalPages: 1000,
  seitenBisher: 0, sammlungsName: "Akten", ontologie: STANDARD_ONTOLOGIE,
} as Parameters<typeof verarbeiteGraphDokument>[1];

/** Sieben Bloecke ergeben sieben Abschnitte — mehr als ein Extraktionsschritt fasst. */
const bloecke = Array.from({ length: 7 }, (_, i) => ({ text: `Person ${i} arbeitet fuer das Amt ${i}.`, location: `S. ${i + 1}` }));
const antwort = (i: number) => JSON.stringify({
  knoten: [{ label: "Person", name: `Person ${i}` }, { label: "Organisation", name: "Landesamt" }],
  kanten: [{ von: `Person ${i}`, typ: "ARBEITET_FUER", nach: "Landesamt" }],
});
const usage = { inputTokens: 100, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dateien.clear();
  vi.stubEnv("GRAPH_EXTRAKTION_MODELL", "test/model");
  vi.stubEnv("GRAPH_EXTRAKTION_MAX_SEITEN", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.dateien.set(prep.blobPath, "%PDF-1.7");
  mocks.extractBlocks.mockResolvedValue({ bloecke, seiten: 7 });
  mocks.generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
    const nummer = Number(/Abschnitt (\d+):/.exec(prompt)?.[1]);
    return { text: antwort(nummer), usage };
  });
  mocks.reserveModelCall.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([] as DocumentRecord[]);
  mocks.finish.mockResolvedValue(undefined);
  mocks.importGraphDaten.mockResolvedValue(undefined);
  mocks.deleteGraph.mockResolvedValue(undefined);
  mocks.setSchema.mockResolvedValue(undefined);
  mocks.verbucheExtraktion.mockResolvedValue(undefined);
});

describe("Dokument in einer Graph-Sammlung", () => {
  it("extrahiert je Abschnitt hinter der Budgetreservierung, fuehrt zusammen und spielt unter der Sperre ein", async () => {
    const ergebnis = await verarbeiteGraphDokument("doc-1", prep);

    // Abschnitte als Artefakt, dann ein Modellaufruf je Abschnitt in zwei Schritten (6 + 1).
    const abschnitte = JSON.parse(mocks.dateien.get("files/user_a/collection_a/doc-1/_abschnitte.json")!);
    expect(abschnitte).toHaveLength(7);
    expect(abschnitte[0]).toEqual({ nummer: 1, text: bloecke[0].text, location: "S. 1" });
    expect(mocks.generateText).toHaveBeenCalledTimes(7);
    expect(mocks.reserveModelCall).toHaveBeenCalledTimes(7);
    expect(mocks.reserveModelCall).toHaveBeenCalledWith("test/model", expect.any(Number), { pool: "ingestion", signal: expect.any(AbortSignal) });
    expect(mocks.reserveModelCall.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateText.mock.invocationCallOrder[0]);
    expect(mocks.generateText.mock.calls[0][0]).toMatchObject({ model: "test/model", maxOutputTokens: 4000, maxRetries: 0 });
    expect(mocks.generateText.mock.calls[0][0].instructions).toContain("Person, Organisation");

    // Verbrauch je Schritt mit Schrittkennung; zwei Schritte, sechs und ein Aufruf.
    expect(mocks.verbucheExtraktion).toHaveBeenCalledTimes(2);
    expect(mocks.verbucheExtraktion).toHaveBeenNthCalledWith(1, "user_a", "test/model",
      { inputTokens: 600, outputTokens: 120, inputTokenDetails: { cacheReadTokens: 30 } }, "step-7");

    // Das Artefakt liegt, bevor eingespielt wird; das Landesamt ist ein Knoten mit sieben Fundstellen.
    const daten = JSON.parse(mocks.dateien.get("files/user_a/collection_a/doc-1/_graph.json")!) as GraphDaten;
    expect(daten).toMatchObject({ version: 1, docId: "doc-1", filename: "bericht.pdf" });
    expect(daten.knoten).toHaveLength(8);
    expect(daten.knoten.find((k) => k.schluessel === "Organisation:landesamt")!.abschnitte).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(daten.kanten).toHaveLength(7);
    expect(daten.abschnitte).toHaveLength(7);

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.deleteGraph).toHaveBeenCalledTimes(1);
    expect(mocks.importGraphDaten).toHaveBeenCalledWith("collection_a", daten);
    expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.importGraphDaten.mock.invocationCallOrder[0]);
    expect(mocks.finish).toHaveBeenCalledWith("doc-1", "collection_a", 7, 15);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(ergebnis).toEqual({ seiten: 7, abschnitte: 15 });
  });

  it("wiederholt eine unlesbare Antwort einmal und laesst danach nur den Abschnitt ausfallen", async () => {
    let unlesbar = 0;
    mocks.generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
      const nummer = Number(/Abschnitt (\d+):/.exec(prompt)?.[1]);
      if (nummer === 2 && unlesbar < 1) { unlesbar += 1; return { text: "Keine Entitaeten gefunden.", usage }; }
      if (nummer === 3) return { text: "kaputt", usage };
      return { text: antwort(nummer), usage };
    });

    const ergebnis = await verarbeiteGraphDokument("doc-1", prep);

    // 7 Abschnitte + 1 Wiederholung fuer Abschnitt 2 + 1 fuer Abschnitt 3
    expect(mocks.generateText).toHaveBeenCalledTimes(9);
    const daten = JSON.parse(mocks.dateien.get("files/user_a/collection_a/doc-1/_graph.json")!) as GraphDaten;
    expect(daten.knoten.some((k) => k.schluessel === "Person:person 2")).toBe(true);
    expect(daten.knoten.some((k) => k.schluessel === "Person:person 3")).toBe(false);
    expect(daten.abschnitte).toHaveLength(7);
    expect(ergebnis.abschnitte).toBe(13);
  });

  it("bricht ab, bevor ein Modellaufruf laeuft, wenn die Extraktionsgrenze gerissen ist", async () => {
    vi.stubEnv("GRAPH_EXTRAKTION_MAX_SEITEN", "5");
    await expect(verarbeiteGraphDokument("doc-1", prep)).rejects.toThrow(/hoechstens 5 vorgesehen/);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.dateien.has("files/user_a/collection_a/doc-1/_abschnitte.json")).toBe(false);
  });

  it("scheitert klar, wenn kein Extraktionsmodell konfiguriert ist", async () => {
    vi.stubEnv("GRAPH_EXTRAKTION_MODELL", "");
    await expect(verarbeiteGraphDokument("doc-1", prep)).rejects.toThrow(/GRAPH_EXTRAKTION_MODELL/);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("liefert bei einem bereits abgeschlossenen Dokument den gespeicherten Stand, ohne erneut einzuspielen", async () => {
    mocks.list.mockResolvedValue([{ id: "doc-1", status: "fertig", pageCount: 7, chunkCount: 15 }] as DocumentRecord[]);
    await expect(verarbeiteGraphDokument("doc-1", prep)).resolves.toEqual({ seiten: 7, abschnitte: 15 });
    expect(mocks.importGraphDaten).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
