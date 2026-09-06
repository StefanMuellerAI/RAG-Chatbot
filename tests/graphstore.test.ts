import { beforeEach, describe, expect, it, vi } from "vitest";
const roQuery = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("falkordb", () => ({ FalkorDB: { connect: vi.fn(async () => ({ selectGraph: () => ({ roQuery, query }) })) } }));
vi.mock("@/lib/env", async (original) => ({ ...await original<typeof import("@/lib/env")>(), optionalEnv: () => "redis://example.invalid" }));
import { ValidationError } from "@/lib/errors";
import type { GraphDaten } from "@/lib/graph-extraktion";
import { importGraphDaten, prepareReadOnlyCypher, runReadOnlyCypher } from "@/lib/graphstore";

beforeEach(() => { roQuery.mockReset(); query.mockReset().mockResolvedValue({ data: [] }); });

describe("server-side Cypher result cap", () => {
  it.each(["5000", "999999999999999999999999999999999999"])("caps an explicit LIMIT %s before execution", (limit) => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT " + limit)).toBe("MATCH (n) RETURN n LIMIT 200");
  });

  it("preserves smaller limits including zero", () => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT 0;")).toBe("MATCH (n) RETURN n LIMIT 0");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT 7")).toBe("MATCH (n) RETURN n LIMIT 7");
  });

  it("does not mistake strings, quoted identifiers, properties or nested expressions for clauses", () => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN '🙂 LIMIT 999' AS value")).toBe("MATCH (n) RETURN '🙂 LIMIT 999' AS value LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n.limit")).toBe("MATCH (n) RETURN n.limit LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n.`LIMIT`")).toBe("MATCH (n) RETURN n.`LIMIT` LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN coalesce(n.x, 'LIMIT 999')")).toContain("LIMIT 200");
  });

  it("removes comments so they cannot swallow the added cap", () => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n // LIMIT 999")).toBe("MATCH (n) RETURN n LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT 999 /* tail */")).toBe("MATCH (n) RETURN n LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) WITH n LIMIT 999 RETURN n")).toBe("MATCH (n) WITH n LIMIT 999 RETURN n LIMIT 200");
  });

  it("rejects UNION branches, expression limits and malformed syntax that could bypass the cap", () => {
    for (const query of [
      "MATCH (n) RETURN n UNION MATCH (m) RETURN m",
      "MATCH (n) RETURN n LIMIT 100 + 200",
      "MATCH (n) RETURN n LIMIT $limit",
      "MATCH (n) RETURN 'unterminated",
      "MATCH (n) RETURN n /* unterminated",
      "MATCH (n RETURN n",
    ]) expect(() => prepareReadOnlyCypher(query)).toThrow();
  });

  it("sends the bounded query to GRAPH.RO_QUERY while retaining the 10-second timeout", async () => {
    roQuery.mockResolvedValue({ data: [{ n: 1 }] });
    await expect(runReadOnlyCypher("collection_1", "MATCH (n) RETURN n LIMIT 1000000")).resolves.toMatchObject({ rows: [{ n: 1 }], rowCount: 1 });
    expect(roQuery).toHaveBeenCalledWith("MATCH (n) RETURN n LIMIT 200", { TIMEOUT: 10_000 });
  });
});

describe("parametrisierter Import eines Extraktionsergebnisses", () => {
  const daten: GraphDaten = {
    version: 1, docId: "doc-1", filename: "bericht.pdf",
    knoten: [
      { schluessel: "Person:max mustermann", label: "Person", name: "Max Mustermann", beschreibung: "Leiter", abschnitte: [1, 2] },
      { schluessel: "Organisation:stadt", label: "Organisation", name: "Stadt", abschnitte: [1] },
    ],
    kanten: [
      { von: "Person:max mustermann", vonLabel: "Person", typ: "ARBEITET_FUER", nach: "Organisation:stadt", nachLabel: "Organisation", abschnitte: [1] },
    ],
    abschnitte: [
      { nummer: 1, fundstelle: "S. 1", auszug: "Max Mustermann leitet …" },
      { nummer: 2, fundstelle: null, auszug: "Weiter im Text" },
    ],
  };
  const aufrufe = () => query.mock.calls.map(([cypher, options]) => [cypher as string, (options as { params?: unknown }).params]);

  it("schreibt Quelle, Abschnitte, Knoten je Label mit Herkunft und Kanten je Typ nur ueber Parameter", async () => {
    await importGraphDaten("collection_1", daten);
    const alle = aufrufe();
    const cypher = alle.map(([c]) => c);

    expect(cypher[0]).toBe("MERGE (q:Quelle {docId: $docId}) SET q.name = $filename");
    expect(alle[0][1]).toEqual({ docId: "doc-1", filename: "bericht.pdf" });
    expect(cypher[1]).toBe("CREATE INDEX FOR (n:Abschnitt) ON (n.id)");
    expect(cypher[2]).toContain("UNWIND $zeilen AS a MERGE (s:Abschnitt {id: a.id})");
    expect(cypher[2]).toContain("MERGE (s)-[:TEIL_VON]->(q)");
    expect(alle[2][1]).toEqual({ docId: "doc-1", zeilen: [
      { id: "doc-1#1", nummer: 1, fundstelle: "S. 1", auszug: "Max Mustermann leitet …" },
      { id: "doc-1#2", nummer: 2, fundstelle: null, auszug: "Weiter im Text" },
    ] });

    expect(cypher[3]).toBe("CREATE INDEX FOR (n:Person) ON (n.schluessel)");
    expect(cypher[4]).toContain("MERGE (n:Person {schluessel: k.schluessel}) ON CREATE SET n.name = k.name");
    expect(alle[4][1]).toEqual({ zeilen: [{ schluessel: "Person:max mustermann", name: "Max Mustermann", beschreibung: "Leiter" }] });
    expect(cypher[5]).toContain("MATCH (n:Person {schluessel: e.schluessel}) MATCH (s:Abschnitt {id: e.abschnitt}) MERGE (n)-[:ERWAEHNT_IN]->(s)");
    expect(alle[5][1]).toEqual({ zeilen: [
      { schluessel: "Person:max mustermann", abschnitt: "doc-1#1" }, { schluessel: "Person:max mustermann", abschnitt: "doc-1#2" },
    ] });
    expect(cypher[6]).toBe("CREATE INDEX FOR (n:Organisation) ON (n.schluessel)");
    expect(alle[7][1]).toEqual({ zeilen: [{ schluessel: "Organisation:stadt", name: "Stadt", beschreibung: null }] });

    const kanten = cypher.at(-1)!;
    expect(kanten).toContain("MATCH (a:Person {schluessel: k.von}) MATCH (b:Organisation {schluessel: k.nach}) MERGE (a)-[r:ARBEITET_FUER]->(b)");
    expect(kanten).toContain("ON CREATE SET r.abschnitte = k.abschnitte");
    expect(alle.at(-1)![1]).toEqual({ zeilen: [{ von: "Person:max mustermann", nach: "Organisation:stadt", abschnitte: ["doc-1#1"] }] });

    // Kein Wert aus den Daten steht im Cypher-Text selbst.
    expect(cypher.join("\n")).not.toContain("Max Mustermann");
    expect(query.mock.calls.every(([, options]) => (options as { TIMEOUT: number }).TIMEOUT === 30_000)).toBe(true);
  });

  it("uebergeht einen bereits vorhandenen Index und meldet einen fehlgeschlagenen Schritt mit Namen", async () => {
    query.mockImplementation(async (cypher: string) => {
      if (cypher.startsWith("CREATE INDEX")) throw new Error("Attribute 'schluessel' is already indexed");
      if (cypher.includes("MERGE (n:Organisation")) throw new Error("boom");
      return { data: [] };
    });
    await expect(importGraphDaten("collection_1", daten)).rejects.toThrow(/Import \(Knoten Organisation\) fehlgeschlagen: boom/);
  });

  it("laesst keine Labels oder Typen in den Cypher-Text, die kein Bezeichner sind", async () => {
    await expect(importGraphDaten("collection_1", {
      ...daten, kanten: [], knoten: [{ ...daten.knoten[0], label: "Person) DELETE n //" }],
    })).rejects.toThrow(ValidationError);
    expect(query.mock.calls.map(([c]) => c as string).some((c) => c.includes("DELETE"))).toBe(false);

    await expect(importGraphDaten("collection_1", {
      ...daten, kanten: [{ ...daten.kanten[0], typ: "ARBEITET FUER" }],
    })).rejects.toThrow(ValidationError);
  });
});
