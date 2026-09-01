import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Collection } from "@/lib/collections";
import { ForbiddenError, ValidationError } from "@/lib/errors";

// Speicher-Zugriffe werden ersetzt: SQL laeuft gegen eine echte In-Memory-DB,
// Graph und Vektor liefern feste Antworten.
const speicher = vi.hoisted(() => ({
  /** Exportierte SQLite-Datei; jeder Aufruf bekommt wie in Produktion eine frische Kopie. */
  bytes: null as Uint8Array | null,
  cypherCalls: [] as string[],
  searchCalls: [] as string[],
}));

vi.mock("@/lib/sqlstore", async () => {
  const echt = await vi.importActual<typeof import("@/lib/sqlstore")>("@/lib/sqlstore");
  return {
    ...echt,
    loadDatabase: async () => {
      const SQL = await echt.getSql();
      return speicher.bytes ? new SQL.Database(speicher.bytes) : new SQL.Database();
    },
  };
});
vi.mock("@/lib/graphstore", () => ({
  runReadOnlyCypher: async (_id: string, cypher: string) => {
    speicher.cypherCalls.push(cypher);
    return {
      columns: ["p"],
      rows: [{ p: { type: "node", labels: ["Person"], properties: { name: "Anna" } } }],
      rowCount: 1,
      truncated: false,
    };
  },
}));
vi.mock("@/lib/vector", () => ({
  search: async (_ns: string, query: string) => {
    speicher.searchCalls.push(query);
    return [
      { score: 0.9, text: "Oeffnungszeiten Mo-Fr 8-16 Uhr", metadata: { docId: "d", filename: "info.pdf", chunkIndex: 0, location: "Seite 1" } },
      { score: 0.1, text: "Rauschen", metadata: { docId: "d", filename: "info.pdf", chunkIndex: 1 } },
    ];
  },
}));

import { newDatabase, replaceTable } from "@/lib/sqlstore";
import { buildTools, toStep, type ToolContext } from "@/lib/tools";

const dokumente: Collection = { id: "c-docs", ownerId: "u1", name: "Handbuch", kind: "vector", namespace: "c-docs", createdAt: "2026-01-01" };
const tabellen: Collection = { id: "c-sql", ownerId: "u1", name: "Umsatz", kind: "sql", namespace: "c-sql", createdAt: "2026-01-02" };
const graph: Collection = { id: "c-graph", ownerId: "u1", name: "Netzwerk", kind: "graph", namespace: "c-graph", createdAt: "2026-01-03" };

type Ausfuehren = (input: Record<string, unknown>) => Promise<unknown>;
function execute(tools: ReturnType<typeof buildTools>, name: string): Ausfuehren {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`Werkzeug ${name} fehlt`);
  const run = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return (input) => run(input, { toolCallId: "t1", messages: [] });
}

beforeAll(async () => {
  const db = await newDatabase();
  replaceTable(db, "umsatz", [{ name: "kunde", type: "TEXT" }, { name: "betrag", type: "REAL" }], [["Alpha", 10], ["Beta", 5]]);
  speicher.bytes = db.export();
  db.close();
});

describe("Werkzeugauswahl", () => {
  it("bietet im Einzelmodus nur das Werkzeug des Sammlungstyps", () => {
    expect(Object.keys(buildTools({ collections: [tabellen], fixed: tabellen }))).toEqual(["run_sql"]);
    expect(Object.keys(buildTools({ collections: [graph], fixed: graph }))).toEqual(["run_cypher"]);
    expect(Object.keys(buildTools({ collections: [dokumente], fixed: dokumente }))).toEqual(["search_documents"]);
  });

  it("bietet im Modus 'alle' die Werkzeuge der vorhandenen Typen", () => {
    expect(Object.keys(buildTools({ collections: [dokumente, tabellen] })).sort()).toEqual(["run_sql", "search_documents"]);
  });
});

describe("Allowlist", () => {
  it("lehnt fremde Sammlungs-IDs ab", async () => {
    const tools = buildTools({ collections: [tabellen] });
    await expect(execute(tools, "run_sql")({ collectionId: "fremd", sql: "SELECT 1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(execute(tools, "run_sql")({ sql: "SELECT 1" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("verlangt den passenden Typ", async () => {
    const tools = buildTools({ collections: [dokumente, tabellen] });
    await expect(execute(tools, "run_sql")({ collectionId: dokumente.id, sql: "SELECT 1" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("ignoriert im Einzelmodus eine mitgeschickte ID", async () => {
    const tools = buildTools({ collections: [tabellen], fixed: tabellen });
    const ergebnis = (await execute(tools, "run_sql")({ collectionId: "egal", sql: "SELECT COUNT(*) AS n FROM umsatz" })) as {
      ok: boolean;
      rows: unknown[][];
    };
    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.rows).toEqual([[2]]);
  });
});

describe("Ausfuehrung", () => {
  it("fuehrt SQL aus und meldet Fehler als Ergebnis statt als Ausnahme", async () => {
    const tools = buildTools({ collections: [tabellen] });
    const gut = (await execute(tools, "run_sql")({ collectionId: tabellen.id, sql: "SELECT kunde FROM umsatz ORDER BY kunde" })) as {
      ok: boolean;
      columns: string[];
      rows: unknown[][];
    };
    expect(gut).toMatchObject({ ok: true, columns: ["kunde"], rows: [["Alpha"], ["Beta"]] });

    const schlecht = (await execute(tools, "run_sql")({ collectionId: tabellen.id, sql: "DROP TABLE umsatz" })) as { ok: boolean; error: string };
    expect(schlecht.ok).toBe(false);
    expect(schlecht.error).toMatch(/lesende/);
  });

  it("fuehrt Cypher aus", async () => {
    const tools = buildTools({ collections: [graph] });
    const ergebnis = (await execute(tools, "run_cypher")({ collectionId: graph.id, cypher: "MATCH (p:Person) RETURN p" })) as { ok: boolean; rowCount: number };
    expect(ergebnis).toMatchObject({ ok: true, rowCount: 1 });
    expect(speicher.cypherCalls).toContain("MATCH (p:Person) RETURN p");
  });

  it("sucht Dokumente, filtert Rauschen und nummeriert Treffer fortlaufend", async () => {
    const gesammelt: unknown[][] = [];
    const context: ToolContext = { collections: [dokumente], onHits: (hits) => gesammelt.push(hits) };
    const tools = buildTools(context);

    const erste = (await execute(tools, "search_documents")({ collectionId: dokumente.id, query: "Oeffnungszeiten" })) as { excerpts: { n: number }[] };
    const zweite = (await execute(tools, "search_documents")({ collectionId: dokumente.id, query: "Adresse" })) as { excerpts: { n: number }[] };

    expect(erste.excerpts.map((e) => e.n)).toEqual([1]);
    expect(zweite.excerpts.map((e) => e.n)).toEqual([2]);
    expect(gesammelt).toHaveLength(2);
    expect(gesammelt[0]).toHaveLength(1);
  });
});

describe("toStep", () => {
  it("bildet Werkzeugaufrufe fuer den Browser ab", () => {
    const context: ToolContext = { collections: [tabellen] };
    const step = toStep(context, "run_sql", { collectionId: tabellen.id, sql: "SELECT 1" }, {
      ok: true,
      columns: ["x"],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    });
    expect(step).toMatchObject({ tool: "run_sql", collectionName: "Umsatz", query: "SELECT 1", rowCount: 1, columns: ["x"] });

    const fehler = toStep(context, "run_sql", { collectionId: "fremd", sql: "SELECT 1" }, undefined, new ForbiddenError("nein"));
    expect(fehler?.error).toBe("nein");
    expect(toStep(context, "unbekannt", {}, {})).toBeNull();
  });
});
