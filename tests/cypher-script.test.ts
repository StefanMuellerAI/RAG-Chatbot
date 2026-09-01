import { describe, expect, it } from "vitest";
import { splitStatements } from "@/lib/cypher-script";
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

describe("prepareReadOnlyCypher", () => {
  it("haengt ein LIMIT an, wenn keines vorhanden ist", () => {
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n")).toBe("MATCH (n) RETURN n LIMIT 200");
    expect(prepareReadOnlyCypher("MATCH (n) RETURN n LIMIT 5;")).toBe("MATCH (n) RETURN n LIMIT 5");
  });

  it("erlaubt nur ein Statement", () => {
    expect(() => prepareReadOnlyCypher("MATCH (n) RETURN n; MATCH (m) DELETE m")).toThrow(ValidationError);
    expect(() => prepareReadOnlyCypher("   ")).toThrow(ValidationError);
  });
});
