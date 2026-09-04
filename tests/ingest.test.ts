import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Blob-Store im Speicher: put/get/del arbeiten auf einer Map, damit die
 * SQLite-Datei einer Sammlung zwischen den Aufrufen tatsaechlich erhalten
 * bleibt und der Lese-Aendere-Schreibe-Zyklus geprueft wird.
 */
const blob = vi.hoisted(() => {
  const dateien = new Map<string, Uint8Array>();
  return {
    dateien,
    put: vi.fn(async (pfad: string, inhalt: Buffer | string) => {
      dateien.set(
        pfad,
        typeof inhalt === "string" ? new TextEncoder().encode(inhalt) : new Uint8Array(inhalt),
      );
      return { pathname: pfad };
    }),
    get: vi.fn(async (pfad: string) => {
      const inhalt = dateien.get(pfad);
      if (!inhalt) return null;
      return { stream: new Blob([inhalt as BlobPart]).stream() };
    }),
    del: vi.fn(async (pfad: string | string[]) => {
      for (const p of Array.isArray(pfad) ? pfad : [pfad]) dateien.delete(p);
    }),
    list: vi.fn(async () => ({ blobs: [], hasMore: false, cursor: undefined })),
  };
});
vi.mock("@vercel/blob", () => blob);

const collections = vi.hoisted(() => ({
  setzeSammlungsSchema: vi.fn(async () => undefined),
}));
vi.mock("@/lib/collections", () => collections);

const graphstore = vi.hoisted(() => ({
  importStatements: vi.fn(async () => undefined),
  deleteGraph: vi.fn(async () => undefined),
  describeGraph: vi.fn(async () => ({
    kind: "graph" as const,
    nodes: 2,
    relationships: 1,
    labels: ["Person"],
    relationshipTypes: ["KENNT"],
    propertyKeys: ["name"],
  })),
}));
vi.mock("@/lib/graphstore", () => graphstore);

const vector = vi.hoisted(() => ({
  loescheDokumentChunks: vi.fn(async () => undefined),
}));
vi.mock("@/lib/vector", () => vector);

import type { DocumentRecord } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import {
  assertAllowedExtension,
  entferneDokumentJeTyp,
  ersetzteDokumente,
  ingestGraph,
  ingestSql,
  seitenAusZeichen,
  seitenAusZeilen,
} from "@/lib/ingest";
import { databasePath } from "@/lib/sqlstore";

const USER = "user_anna";
const SAMMLUNG = "11111111-1111-4111-8111-111111111111";

const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function satz(teil: Partial<DocumentRecord> & { id: string; filename: string }): DocumentRecord {
  return {
    collectionId: SAMMLUNG,
    userId: USER,
    contentType: "application/octet-stream",
    blobPath: `files/${USER}/${SAMMLUNG}/${teil.id}/${teil.filename}`,
    sizeBytes: 10,
    pageCount: 1,
    chunkCount: 1,
    status: "fertig",
    error: null,
    workflowRunId: null,
    uploadedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...teil,
  };
}

/** Das zuletzt festgehaltene Schema der Sammlung. */
function letztesSchema() {
  const aufrufe = collections.setzeSammlungsSchema.mock.calls as unknown as [string, string, unknown][];
  return aufrufe.at(-1)?.[2];
}

beforeEach(() => {
  blob.dateien.clear();
  vi.clearAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
});

describe("assertAllowedExtension", () => {
  it("laesst je Typ nur die passenden Endungen durch", () => {
    expect(() => assertAllowedExtension("vector", "Bericht.PDF")).not.toThrow();
    expect(() => assertAllowedExtension("vector", "sitzung.mp3")).not.toThrow();
    expect(() => assertAllowedExtension("vector", "daten.csv")).toThrow(ValidationError);
    expect(() => assertAllowedExtension("sql", "Umsatz 2025.csv")).not.toThrow();
    expect(() => assertAllowedExtension("sql", "umsatz.xlsx")).toThrow(/Tabellen-Sammlung/);
    expect(() => assertAllowedExtension("graph", "graph.cypher")).not.toThrow();
    expect(() => assertAllowedExtension("graph", "graph.cql")).not.toThrow();
    expect(() => assertAllowedExtension("graph", "notizen.txt")).not.toThrow();
    expect(() => assertAllowedExtension("graph", "daten.csv")).toThrow(/Graph-Sammlung/);
  });
});

describe("Seitenschaetzung", () => {
  it("rechnet Zeilen und Zeichen nach dem Massstab von XLSX und DOCX um", () => {
    expect(seitenAusZeilen(0)).toBe(0);
    expect(seitenAusZeilen(1)).toBe(1);
    expect(seitenAusZeilen(50)).toBe(1);
    expect(seitenAusZeilen(51)).toBe(2);
    expect(seitenAusZeichen(0)).toBe(0);
    expect(seitenAusZeichen(3000)).toBe(1);
    expect(seitenAusZeichen(3001)).toBe(2);
  });
});

describe("Tabellen-Sammlung (sql)", () => {
  const CSV = "Kunde;Betrag\nAlpha;10,5\nBeta;20\nGamma;5,25\n";

  it("schreibt eine CSV als Tabelle in die SQLite-Datei und haelt das Schema fest", async () => {
    const reihenfolge: string[] = [];
    blob.put.mockImplementationOnce(async (pfad: string, inhalt: Buffer | string) => {
      reihenfolge.push("put");
      blob.dateien.set(pfad, new Uint8Array(inhalt as Buffer));
      return { pathname: pfad };
    });

    const ergebnis = await ingestSql({
      userId: USER,
      collectionId: SAMMLUNG,
      buffer: enc(CSV),
      filename: "Umsatz 2025.csv",
      vorSchreiben: (seiten) => {
        reihenfolge.push(`pruefe:${seiten}`);
      },
    });

    expect(ergebnis.units).toBe(3);
    expect(ergebnis.pageCount).toBe(1);
    expect(ergebnis.replacedTable).toBe("umsatz_2025");
    expect(ergebnis.schema.kind).toBe("sql");
    if (ergebnis.schema.kind === "sql") {
      expect(ergebnis.schema.tables).toHaveLength(1);
      expect(ergebnis.schema.tables[0]).toMatchObject({
        name: "umsatz_2025",
        rows: 3,
        columns: [
          { name: "kunde", type: "TEXT" },
          { name: "betrag", type: "REAL" },
        ],
      });
    }

    // Die Seitenpruefung greift, BEVOR die Datei geschrieben wird.
    expect(reihenfolge).toEqual(["pruefe:1", "put"]);
    expect(blob.dateien.has(databasePath(USER, SAMMLUNG))).toBe(true);
    expect(collections.setzeSammlungsSchema).toHaveBeenCalledWith(USER, SAMMLUNG, ergebnis.schema);
  });

  it("schreibt nichts, wenn die Seitenpruefung ablehnt", async () => {
    await expect(
      ingestSql({
        userId: USER,
        collectionId: SAMMLUNG,
        buffer: enc(CSV),
        filename: "umsatz.csv",
        vorSchreiben: () => {
          throw new Error("zu gross");
        },
      }),
    ).rejects.toThrow("zu gross");

    expect(blob.put).not.toHaveBeenCalled();
    expect(collections.setzeSammlungsSchema).not.toHaveBeenCalled();
  });

  it("ersetzt eine gleichnamige Tabelle vollstaendig statt eine zweite anzulegen", async () => {
    await ingestSql({ userId: USER, collectionId: SAMMLUNG, buffer: enc(CSV), filename: "umsatz.csv" });

    const neu = await ingestSql({
      userId: USER,
      collectionId: SAMMLUNG,
      buffer: enc("Monat,Umsatz\nJan,100\nFeb,200\n"),
      filename: "Umsatz.CSV",
    });

    expect(neu.replacedTable).toBe("umsatz");
    expect(neu.units).toBe(2);
    if (neu.schema.kind === "sql") {
      expect(neu.schema.tables.map((t) => t.name)).toEqual(["umsatz"]);
      expect(neu.schema.tables[0].columns.map((c) => c.name)).toEqual(["monat", "umsatz"]);
      expect(neu.schema.tables[0].rows).toBe(2);
    }
  });

  it("nennt die fertigen Saetze, deren Tabelle ein Upload ersetzt", () => {
    const vorhanden = [
      satz({ id: "alt", filename: "Umsatz.csv" }),
      satz({ id: "fehl", filename: "umsatz.csv", status: "fehler" }),
      satz({ id: "laeuft", filename: "umsatz.csv", status: "laeuft" }),
      satz({ id: "andere", filename: "kunden.csv" }),
      satz({ id: "ich", filename: "umsatz.csv" }),
    ];

    expect(ersetzteDokumente(vorhanden, "umsatz.csv", "ich").map((s) => s.id)).toEqual([
      "alt",
      "fehl",
    ]);
  });

  it("entfernt eine Tabelle und berechnet das Schema neu — leer wird null", async () => {
    await ingestSql({ userId: USER, collectionId: SAMMLUNG, buffer: enc(CSV), filename: "umsatz.csv" });
    await ingestSql({
      userId: USER,
      collectionId: SAMMLUNG,
      buffer: enc("id,name\n1,A\n"),
      filename: "kunden.csv",
    });

    await entferneDokumentJeTyp({
      kind: "sql",
      userId: USER,
      collectionId: SAMMLUNG,
      satz: satz({ id: "u", filename: "umsatz.csv" }),
      uebrige: [],
    });

    const schema = letztesSchema() as { kind: string; tables: { name: string }[] };
    expect(schema.kind).toBe("sql");
    expect(schema.tables.map((t) => t.name)).toEqual(["kunden"]);

    await entferneDokumentJeTyp({
      kind: "sql",
      userId: USER,
      collectionId: SAMMLUNG,
      satz: satz({ id: "k", filename: "kunden.csv" }),
      uebrige: [],
    });

    expect(letztesSchema()).toBeNull();
  });

  it("laesst die Datenbank in Ruhe, wenn der Satz nie fertig wurde", async () => {
    await ingestSql({ userId: USER, collectionId: SAMMLUNG, buffer: enc(CSV), filename: "umsatz.csv" });
    vi.clearAllMocks();

    // Ein gescheiterter zweiter Upload gleichen Namens darf die Tabelle des
    // ersten nicht mitnehmen.
    await entferneDokumentJeTyp({
      kind: "sql",
      userId: USER,
      collectionId: SAMMLUNG,
      satz: satz({ id: "f", filename: "umsatz.csv", status: "fehler" }),
      uebrige: [],
    });

    expect(blob.put).not.toHaveBeenCalled();
    expect(collections.setzeSammlungsSchema).not.toHaveBeenCalled();
  });
});

describe("Graph-Sammlung", () => {
  const SKRIPT = "\uFEFFCREATE (a:Person {name: 'Anna'});\nCREATE (b:Person {name: 'Bert'});\n";

  it("spielt die Statements ein und haelt das Schema fest", async () => {
    const ergebnis = await ingestGraph({
      userId: USER,
      collectionId: SAMMLUNG,
      buffer: enc(SKRIPT),
      uebrige: [],
    });

    expect(ergebnis.units).toBe(2);
    expect(ergebnis.pageCount).toBe(1);
    expect(graphstore.importStatements).toHaveBeenCalledWith(SAMMLUNG, [
      "CREATE (a:Person {name: 'Anna'})",
      "CREATE (b:Person {name: 'Bert'})",
    ]);
    expect(graphstore.deleteGraph).not.toHaveBeenCalled();
    expect(collections.setzeSammlungsSchema).toHaveBeenCalledWith(
      USER,
      SAMMLUNG,
      expect.objectContaining({ kind: "graph", nodes: 2 }),
    );
  });

  it("ueberspringt Neo4j-CREATE-CONSTRAINT und spielt die Datensaetze ein", async () => {
    const ergebnis = await ingestGraph({
      userId: USER,
      collectionId: SAMMLUNG,
      buffer: enc(
        "CREATE CONSTRAINT film_titel IF NOT EXISTS FOR (f:Film) REQUIRE f.titel IS UNIQUE;\n" +
          "CREATE (f:Film {titel: 'Dune'});\n",
      ),
      uebrige: [],
    });

    expect(ergebnis.units).toBe(1);
    expect(graphstore.importStatements).toHaveBeenCalledWith(SAMMLUNG, [
      "CREATE (f:Film {titel: 'Dune'})",
    ]);
  });

  it("lehnt ein Skript ab, das nur aus CREATE CONSTRAINT besteht", async () => {
    await expect(
      ingestGraph({
        userId: USER,
        collectionId: SAMMLUNG,
        buffer: enc(
          "CREATE CONSTRAINT film_titel IF NOT EXISTS FOR (f:Film) REQUIRE f.titel IS UNIQUE;",
        ),
        uebrige: [],
      }),
    ).rejects.toThrow(/keine CREATE-\/MERGE-Statements/);

    expect(graphstore.importStatements).not.toHaveBeenCalled();
    expect(graphstore.deleteGraph).not.toHaveBeenCalled();
  });

  it("baut den Graphen nach einem fehlgeschlagenen Import aus den uebrigen Skripten neu auf", async () => {
    const aeltester = satz({
      id: "s1",
      filename: "basis.cypher",
      uploadedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const juengster = satz({
      id: "s2",
      filename: "ergaenzung.cypher",
      uploadedAt: new Date("2026-02-01T00:00:00Z"),
    });
    blob.dateien.set(aeltester.blobPath, new TextEncoder().encode("CREATE (:A);"));
    blob.dateien.set(juengster.blobPath, new TextEncoder().encode("CREATE (:B);"));

    graphstore.importStatements.mockRejectedValueOnce(
      new ValidationError("Statement 2 fehlgeschlagen: Syntax error"),
    );

    await expect(
      ingestGraph({
        userId: USER,
        collectionId: SAMMLUNG,
        buffer: enc("CREATE (:C); KAPUTT;"),
        // Absichtlich in falscher Reihenfolge: der Neuaufbau muss nach
        // Hochladedatum sortieren.
        uebrige: [juengster, aeltester],
      }),
    ).rejects.toThrow(/Statement 2/);

    expect(graphstore.deleteGraph).toHaveBeenCalledWith(SAMMLUNG);
    // Erster Aufruf: der gescheiterte Import; danach die uebrigen, aelteste zuerst.
    expect(graphstore.importStatements.mock.calls.slice(1)).toEqual([
      [SAMMLUNG, ["CREATE (:A)"]],
      [SAMMLUNG, ["CREATE (:B)"]],
    ]);
    expect(collections.setzeSammlungsSchema).toHaveBeenCalledWith(
      USER,
      SAMMLUNG,
      expect.objectContaining({ kind: "graph" }),
    );
  });

  it("setzt das Schema auf null, wenn nach dem Fehler kein Skript uebrig ist", async () => {
    graphstore.importStatements.mockRejectedValueOnce(new Error("Verbindung zu FalkorDB fehlgeschlagen"));

    await expect(
      ingestGraph({ userId: USER, collectionId: SAMMLUNG, buffer: enc("CREATE (:X);"), uebrige: [] }),
    ).rejects.toThrow(/Verbindung/);

    expect(graphstore.deleteGraph).toHaveBeenCalledTimes(1);
    expect(graphstore.describeGraph).not.toHaveBeenCalled();
    expect(letztesSchema()).toBeNull();
  });

  it("entfernt ein Skript, indem der Graph ohne dieses neu aufgebaut wird", async () => {
    const bleibt = satz({ id: "b", filename: "bleibt.cypher" });
    const weg = satz({ id: "w", filename: "weg.cypher" });
    blob.dateien.set(bleibt.blobPath, new TextEncoder().encode("MERGE (:Bleibt);"));
    blob.dateien.set(weg.blobPath, new TextEncoder().encode("MERGE (:Weg);"));

    await entferneDokumentJeTyp({
      kind: "graph",
      userId: USER,
      collectionId: SAMMLUNG,
      satz: weg,
      uebrige: [bleibt, weg],
    });

    expect(graphstore.deleteGraph).toHaveBeenCalledWith(SAMMLUNG);
    expect(graphstore.importStatements).toHaveBeenCalledTimes(1);
    expect(graphstore.importStatements).toHaveBeenCalledWith(SAMMLUNG, ["MERGE (:Bleibt)"]);
  });
});

describe("Dokumentensammlung (vector)", () => {
  it("entfernt nur die Abschnitte in der Vektor-Datenbank", async () => {
    const dokument = satz({ id: "d", filename: "bericht.pdf", chunkCount: 7 });

    await entferneDokumentJeTyp({
      kind: "vector",
      userId: USER,
      collectionId: SAMMLUNG,
      satz: dokument,
      uebrige: [],
    });

    expect(vector.loescheDokumentChunks).toHaveBeenCalledWith(SAMMLUNG, "d", 7);
    expect(collections.setzeSammlungsSchema).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });
});
