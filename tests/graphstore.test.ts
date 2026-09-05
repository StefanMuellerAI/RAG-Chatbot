import { beforeEach, describe, expect, it, vi } from "vitest";
const roQuery = vi.hoisted(() => vi.fn());
vi.mock("falkordb", () => ({ FalkorDB: { connect: vi.fn(async () => ({ selectGraph: () => ({ roQuery }) })) } }));
vi.mock("@/lib/env", async (original) => ({ ...await original<typeof import("@/lib/env")>(), optionalEnv: () => "redis://example.invalid" }));
import { prepareReadOnlyCypher, runReadOnlyCypher } from "@/lib/graphstore";

beforeEach(() => roQuery.mockReset());

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
