import { describe, expect, it, vi } from "vitest";
import { GRAPH_SCHEMA, SQL_SCHEMA, beispielSammlung } from "./hilfen";

// lib/ai.ts zieht Pinecone und die Datenbank mit. Beides wird hier nicht
// gebraucht — geprueft werden nur Texte.
vi.mock("@/lib/vector", () => ({ MIN_SCORE: 0.82, sucheInSammlung: vi.fn() }));
vi.mock("@/lib/collections", () => ({ ladeEigeneSammlungen: vi.fn() }));

import { SYSTEM_ANWEISUNG, baueKatalog, baueSystemanweisung } from "@/lib/ai";

const dokumente = beispielSammlung({
  id: "c-docs",
  name: "Handbuch",
  kind: "vector",
  description: "Bedienungsanleitungen",
  documentCount: 3,
});
const tabellen = beispielSammlung({
  id: "c-sql",
  name: "Umsatz",
  kind: "sql",
  schema: SQL_SCHEMA,
  documentCount: 1,
});
const graph = beispielSammlung({
  id: "c-graph",
  name: "Netzwerk",
  kind: "graph",
  schema: GRAPH_SCHEMA,
  documentCount: 2,
});

describe("baueKatalog", () => {
  it("beschreibt Dokumentensammlungen wie bisher", () => {
    const katalog = baueKatalog([dokumente]);

    expect(katalog).toContain("id: c-docs");
    expect(katalog).toContain("Name: Handbuch");
    expect(katalog).toContain("Inhalt: Bedienungsanleitungen");
    expect(katalog).toMatch(/Art: .* · 3 Dokumente/);
    expect(katalog).not.toContain("Tabelle");
  });

  it("nennt bei Tabellen-Sammlungen Tabellen, Spalten, Typen, Beispiele und Zeilenzahl", () => {
    const katalog = baueKatalog([tabellen]);

    expect(katalog).toContain("Werkzeug sql_ausfuehren");
    expect(katalog).toContain('Tabelle "umsatz" (1.200 Zeilen)');
    expect(katalog).toContain("kunde TEXT (z. B. Alpha, Beta)");
    expect(katalog).toContain("betrag REAL (z. B. 10, 5.5)");
  });

  it("nennt bei Graph-Sammlungen Knoten, Kanten, Labels, Beziehungstypen und Eigenschaften", () => {
    const katalog = baueKatalog([graph]);

    expect(katalog).toContain("Werkzeug cypher_ausfuehren");
    expect(katalog).toContain("120 Knoten, 340 Kanten");
    expect(katalog).toContain("Labels: Person, Firma");
    expect(katalog).toContain("Beziehungstypen: KENNT, ARBEITET_BEI");
    expect(katalog).toContain("Eigenschaften: name, seit");
  });

  it("weist auf leere Bestaende hin", () => {
    const leer = baueKatalog([
      beispielSammlung({ id: "s", name: "Leer", kind: "sql" }),
      beispielSammlung({ id: "g", name: "Leer2", kind: "graph" }),
    ]);

    expect(leer).toContain("Noch keine Tabellen.");
    expect(leer).toContain("Graph ist noch leer.");
  });

  it("begrenzt den Schema-Text je Sammlung", () => {
    const viele = beispielSammlung({
      id: "gross",
      name: "Gross",
      kind: "sql",
      schema: {
        kind: "sql",
        tables: Array.from({ length: 60 }, (_, i) => ({
          name: `tabelle_${i}`,
          rows: 10,
          columns: Array.from({ length: 12 }, (_, j) => ({
            name: `spalte_${j}`,
            type: "TEXT" as const,
          })),
        })),
      },
    });

    const katalog = baueKatalog([viele]);
    // Kopf plus hoechstens ~1.500 Zeichen Schema.
    expect(katalog.length).toBeLessThan(1_800);
    expect(katalog).toContain('Tabelle "tabelle_0"');
    expect(katalog).not.toContain('Tabelle "tabelle_59"');
  });
});

describe("baueSystemanweisung", () => {
  it("bleibt fuer reine Dokumentensammlungen unveraendert", () => {
    expect(baueSystemanweisung([dokumente])).toBe(SYSTEM_ANWEISUNG);
    expect(baueSystemanweisung([dokumente, dokumente])).toBe(SYSTEM_ANWEISUNG);
    expect(SYSTEM_ANWEISUNG).not.toContain("sql_ausfuehren");
  });

  it("haengt SQL-Regeln nur bei Tabellen-Sammlungen an", () => {
    const mitSql = baueSystemanweisung([dokumente, tabellen]);

    expect(mitSql.startsWith(SYSTEM_ANWEISUNG)).toBe(true);
    expect(mitSql).toContain("sql_ausfuehren");
    expect(mitSql).toContain("SQLite");
    expect(mitSql).toContain("200 Zeilen");
    expect(mitSql).not.toContain("cypher_ausfuehren");
  });

  it("haengt Cypher-Regeln nur bei Graph-Sammlungen an", () => {
    const mitGraph = baueSystemanweisung([graph]);

    expect(mitGraph).toContain("cypher_ausfuehren");
    expect(mitGraph).toContain("FalkorDB");
    expect(mitGraph).toContain("Beziehungs-Alias");
    expect(mitGraph).toContain("Keine Schreiboperationen");
    expect(mitGraph).not.toContain("SQLite");
    // Einzelmodus: die Sammlung ist fest gebunden.
    expect(mitGraph).toContain("genau eine Sammlung");
  });

  it("nennt die Korrekturgrenze und die Herkunftsangabe", () => {
    const beides = baueSystemanweisung([tabellen, graph]);

    expect(beides).toContain("hoechstens zweimal");
    expect(beides).toContain("aus welcher Sammlung");
    expect(beides).not.toContain("genau eine Sammlung");
  });
});
