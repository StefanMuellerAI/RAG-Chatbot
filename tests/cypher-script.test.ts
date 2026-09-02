import { describe, expect, it } from "vitest";
import { splitStatements } from "@/lib/cypher-script";
import { ValidationError } from "@/lib/errors";

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
