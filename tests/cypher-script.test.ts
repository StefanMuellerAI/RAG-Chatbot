import { describe, expect, it } from "vitest";
import { istSchemaStatement, splitStatements, statementsZumImport } from "@/lib/cypher-script";
import { ValidationError } from "@/lib/errors";
import { prepareReadOnlyCypher } from "@/lib/graphstore";

describe("splitStatements", () => {
  it("trennt an Semikolons, aber nicht in Strings oder Kommentaren", () => {
    const script = `
      // Personen; mit Kommentar
      CREATE (a:Person {name: 'Anna; Müller', motto: "sag; nichts"});
      /* Block; Kommentar */
      CREATE (b:Person {name: 'Bert'})
      ;
      MATCH (a:Person {name: 'Anna; Müller'}), (b:Person {name: 'Bert'}) CREATE (a)-[:KENNT]->(b);
    `;
    const statements = splitStatements(script);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("Anna; Müller");
    expect(statements[0]).not.toContain("Kommentar");
    expect(statements[2]).toMatch(/^MATCH/);
  });

  it("verkraftet fehlendes Schluss-Semikolon und Escapes", () => {
    expect(splitStatements("CREATE (n {t: 'it\\'s; fine'})")).toHaveLength(1);
  });

  it("lehnt leere Skripte und offene Strings ab", () => {
    expect(() => splitStatements("// nur Kommentar")).toThrow(ValidationError);
    expect(() => splitStatements("CREATE (n {t: 'offen})")).toThrow(ValidationError);
  });
});

describe("istSchemaStatement", () => {
  it("erkennt Neo4j-Constraints und -Indexe, laesst Datensaetze stehen", () => {
    expect(
      istSchemaStatement(
        "CREATE CONSTRAINT film_titel IF NOT EXISTS FOR (f:Film) REQUIRE f.titel IS UNIQUE",
      ),
    ).toBe(true);
    expect(istSchemaStatement("CREATE CONSTRAINT ON (f:Film) ASSERT f.titel IS UNIQUE")).toBe(true);
    expect(istSchemaStatement("DROP CONSTRAINT film_titel IF EXISTS")).toBe(true);
    expect(
      istSchemaStatement("CREATE INDEX film_titel IF NOT EXISTS FOR (f:Film) ON (f.titel)"),
    ).toBe(true);
    expect(istSchemaStatement("CREATE RANGE INDEX jahr FOR (f:Film) ON (f.jahr)")).toBe(true);
    expect(istSchemaStatement("CREATE UNIQUE (a)-[:KENNT]->(b)")).toBe(false);
    expect(istSchemaStatement("CREATE (n:Constraint {name: 'x'})")).toBe(false);
    expect(istSchemaStatement("MERGE (f:Film {titel: 'Dune'})")).toBe(false);
  });
});

describe("statementsZumImport", () => {
  it("entfernt Schema-Statements und behaelt CREATE/MERGE", () => {
    const statements = statementsZumImport(`
      CREATE CONSTRAINT film_titel IF NOT EXISTS FOR (f:Film) REQUIRE f.titel IS UNIQUE;
      CREATE (f:Film {titel: 'Dune'});
      MERGE (r:Regie {name: 'Villeneuve'});
    `);
    expect(statements).toEqual([
      "CREATE (f:Film {titel: 'Dune'})",
      "MERGE (r:Regie {name: 'Villeneuve'})",
    ]);
  });

  it("lehnt Skripte ab, die nur aus Schema-Statements bestehen", () => {
    expect(() =>
      statementsZumImport(
        "CREATE CONSTRAINT film_titel IF NOT EXISTS FOR (f:Film) REQUIRE f.titel IS UNIQUE;",
      ),
    ).toThrow(/keine CREATE-\/MERGE-Statements/);
  });
});

// Das Graph-Modul muss ohne FALKORDB_URL importierbar sein — hier laeuft kein Server.
describe("prepareReadOnlyCypher", () => {
  it("haengt ein LIMIT an, wenn keines vorhanden ist", () => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n")).toBe("MATCH (n) RETURN n LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT 5;")).toBe("MATCH (n) RETURN n LIMIT 5");
  });

  it("erlaubt nur ein Statement", () => {
    expect(() => prepareReadOnlyCypher("MATCH (n) RETURN n; MATCH (m) DELETE m")).toThrow(
      ValidationError,
    );
    expect(() => prepareReadOnlyCypher("   ")).toThrow(ValidationError);
  });
});
