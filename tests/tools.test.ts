import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beispielSammlung } from "./hilfen";

/**
 * Speicher-Zugriffe werden ersetzt: SQL laeuft gegen eine echte In-Memory-DB
 * aus sql.js, der Graph liefert feste Antworten.
 */
const speicher = vi.hoisted(() => ({
  /** Exportierte SQLite-Datei; jeder Aufruf bekommt wie in Produktion eine frische Kopie. */
  bytes: null as Uint8Array | null,
  geladen: [] as { userId: string; collectionId: string }[],
  cypherCalls: [] as string[],
  cypherExecution: vi.fn<(id: string, cypher: string) => Promise<void>>(async () => undefined),
  lock: vi.fn<(key: string, owner: string, seconds: number) => Promise<boolean>>(async () => true),
  unlock: vi.fn<(key: string, owner: string) => Promise<void>>(async () => undefined),
}));
vi.mock("@/lib/ratelimit", () => ({ erwirbSperre: speicher.lock, gibSperreFrei: speicher.unlock, sperrSchluessel: (id: string) => `wa:write:${id}` }));

vi.mock("@/lib/sqlstore", async () => {
  const echt = await vi.importActual<typeof import("@/lib/sqlstore")>("@/lib/sqlstore");
  return {
    ...echt,
    loadDatabase: async (userId: string, collectionId: string) => {
      speicher.geladen.push({ userId, collectionId });
      const SQL = await echt.getSql();
      return speicher.bytes ? new SQL.Database(speicher.bytes) : new SQL.Database();
    },
  };
});

vi.mock("@/lib/capacity", () => ({ withCapacity: async (_kind: string, work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/sql-executor", () => ({
  runSql: async (collection: { userId: string; id: string }, query: string) => {
    const store = await import("@/lib/sqlstore");
    const db = await store.loadDatabase(collection.userId, collection.id);
    try { return store.runReadOnlyQuery(db, query); } finally { db.close(); }
  },
}));

vi.mock("@/lib/graphstore", () => ({
  runReadOnlyCypher: async (_id: string, cypher: string) => {
    speicher.cypherCalls.push(cypher);
    await speicher.cypherExecution(_id, cypher);
    return {
      columns: ["p"],
      rows: [{ p: { type: "node", labels: ["Person"], properties: { name: "Anna" } } }],
      rowCount: 1,
      truncated: false,
    };
  },
}));

import { newDatabase, replaceTable } from "@/lib/sqlstore";
import { ResourceBusyError, ToolUnavailableError } from "@/lib/errors";
import {
  ERGEBNIS_MAX_ZEICHEN,
  baueCypherWerkzeug,
  baueSqlWerkzeug,
  capRows,
  toStep,
} from "@/lib/tools";

const USER = "user_anna";
const dokumente = beispielSammlung({ id: "c-docs", name: "Handbuch", kind: "vector" });
const tabellen = beispielSammlung({ id: "c-sql", name: "Umsatz", kind: "sql" });
const graph = beispielSammlung({ id: "c-graph", name: "Netzwerk", kind: "graph" });

type Ergebnis = {
  ok: boolean;
  error?: string;
  collection?: string;
  columns?: string[];
  rows?: unknown[];
  rowCount?: number;
  truncated?: boolean;
};

/** Ruft `execute` eines Werkzeugs so auf, wie es das SDK taete. */
function ausfuehren(
  werkzeug: ReturnType<typeof baueSqlWerkzeug> | ReturnType<typeof baueCypherWerkzeug>,
) {
  const run = werkzeug.execute as unknown as (
    input: unknown,
    options: unknown,
  ) => Promise<Ergebnis>;
  return (input: Record<string, unknown>) => run(input, { toolCallId: "t1", messages: [] });
}

beforeAll(async () => {
  const db = await newDatabase();
  replaceTable(
    db,
    "umsatz",
    [
      { name: "kunde", type: "TEXT" },
      { name: "betrag", type: "REAL" },
    ],
    [
      ["Alpha", 10],
      ["Beta", 5],
    ],
  );
  speicher.bytes = db.export();
  db.close();
});
beforeEach(() => {
  speicher.lock.mockReset().mockResolvedValue(true);
  speicher.unlock.mockReset().mockResolvedValue(undefined);
  speicher.cypherExecution.mockReset().mockResolvedValue(undefined);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function useExclusiveCollectionLocks() {
  const owners = new Map<string, string>();
  speicher.lock.mockImplementation(async (key, owner) => {
    if (owners.has(key)) return false;
    owners.set(key, owner);
    return true;
  });
  speicher.unlock.mockImplementation(async (key: string, owner: string) => {
    if (owners.get(key) === owner) owners.delete(key);
  });
  return owners;
}

describe("Allowlist", () => {
  it("lehnt fremde Sammlungs-IDs als Ergebnis ab, nicht als Ausnahme", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [dokumente, tabellen]));
    const ergebnis = await sql({ collectionId: "fremd", sql: "SELECT 1" });

    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.error).toMatch(/nicht zugaenglich/);
    // Die Meldung nennt die erlaubten IDs des passenden Typs, damit sich das
    // Modell korrigieren kann — die Dokumentensammlung gehoert nicht dazu.
    expect(ergebnis.error).toContain("c-sql");
    expect(ergebnis.error).not.toContain("c-docs");
    expect(speicher.geladen).toHaveLength(0);
  });

  it("verlangt den passenden Typ", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [dokumente, tabellen]));
    const ergebnis = await sql({ collectionId: dokumente.id, sql: "SELECT 1" });

    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.error).toMatch(/Dokumente/);
    expect(ergebnis.error).toMatch(/Tabellen/);

    const cypher = ausfuehren(baueCypherWerkzeug([tabellen, graph]));
    const falsch = await cypher({ collectionId: tabellen.id, cypher: "MATCH (n) RETURN n" });
    expect(falsch.ok).toBe(false);
    expect(falsch.error).toMatch(/Graph/);
  });

  it("bindet im Einzelmodus die Sammlung fest und ignoriert eine mitgeschickte ID", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [tabellen]));
    const ergebnis = await sql({ collectionId: "egal", sql: "SELECT COUNT(*) AS n FROM umsatz" });

    expect(ergebnis.ok).toBe(true);
    expect(ergebnis.rows).toEqual([[2]]);
    expect(speicher.geladen.at(-1)).toEqual({ userId: USER, collectionId: tabellen.id });

    const ohneId = await sql({ sql: "SELECT COUNT(*) AS n FROM umsatz" });
    expect(ohneId.ok).toBe(true);
  });

  it("lehnt im Einzelmodus den falschen Typ trotzdem ab", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [dokumente]));
    const ergebnis = await sql({ sql: "SELECT 1" });
    expect(ergebnis.ok).toBe(false);
  });
});

describe("Ausfuehrung", () => {
  it("fuehrt SQL gegen die Datenbank des Nutzers aus", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [dokumente, tabellen]));
    const ergebnis = await sql({
      collectionId: tabellen.id,
      sql: "SELECT kunde FROM umsatz ORDER BY kunde",
    });

    expect(ergebnis).toMatchObject({
      ok: true,
      collection: "Umsatz",
      columns: ["kunde"],
      rows: [["Alpha"], ["Beta"]],
      rowCount: 2,
      truncated: false,
    });
    expect(speicher.geladen.at(-1)).toEqual({ userId: USER, collectionId: tabellen.id });
  });

  it("meldet SQL-Fehler und Schreibversuche als Ergebnis statt als Ausnahme", async () => {
    const sql = ausfuehren(baueSqlWerkzeug(USER, [tabellen]));

    const schreibend = await sql({ sql: "DROP TABLE umsatz" });
    expect(schreibend.ok).toBe(false);
    expect(schreibend.error).toMatch(/lesende/);

    const falscheSpalte = await sql({ sql: "SELECT gibt_es_nicht FROM umsatz" });
    expect(falscheSpalte.ok).toBe(false);
    expect(falscheSpalte.error).toMatch(/SQL-Fehler/);
  });

  it("fuehrt Cypher gegen den Graphen der Sammlung aus", async () => {
    const cypher = ausfuehren(baueCypherWerkzeug([graph]));
    const ergebnis = await cypher({ cypher: "MATCH (p:Person) RETURN p" });

    expect(ergebnis).toMatchObject({ ok: true, collection: "Netzwerk", rowCount: 1 });
    expect(speicher.cypherCalls).toContain("MATCH (p:Person) RETURN p");
    expect(speicher.lock).toHaveBeenCalledWith("wa:write:c-graph", expect.any(String), 30);
    expect(speicher.unlock).toHaveBeenCalledExactlyOnceWith("wa:write:c-graph", speicher.lock.mock.calls[0][1]);
  });

  it("serializes parallel tool calls to the same graph without rejecting its own request", async () => {
    const owners = useExclusiveCollectionLocks();
    const entered = deferred();
    const gate = deferred();
    let active = 0;
    let maximumActive = 0;
    speicher.cypherExecution.mockImplementation(async (_id, query) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (query === "MATCH (first) RETURN first") {
          entered.resolve();
          await gate.promise;
        }
      } finally { active -= 1; }
    });
    const cypher = ausfuehren(baueCypherWerkzeug([graph]));
    const first = cypher({ cypher: "MATCH (first) RETURN first" });
    await entered.promise;
    const second = cypher({ cypher: "MATCH (second) RETURN second" });
    const results = Promise.allSettled([first, second]);
    // The first read remains in progress while the second invocation starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();

    expect(await results).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ ok: true }) },
      { status: "fulfilled", value: expect.objectContaining({ ok: true }) },
    ]);
    expect(speicher.cypherExecution.mock.calls.map(([, query]) => query)).toEqual([
      "MATCH (first) RETURN first", "MATCH (second) RETURN second",
    ]);
    expect(maximumActive).toBe(1);
    expect(owners.size).toBe(0);
  });

  it("keeps independent graph collections concurrent", async () => {
    const owners = useExclusiveCollectionLocks();
    const otherGraph = beispielSammlung({ id: "c-other-graph", name: "Filme", kind: "graph" });
    const gate = deferred();
    let active = 0;
    let maximumActive = 0;
    speicher.cypherExecution.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { await gate.promise; } finally { active -= 1; }
    });
    const cypher = ausfuehren(baueCypherWerkzeug([graph, otherGraph]));
    const results = Promise.allSettled([
      cypher({ collectionId: graph.id, cypher: "MATCH (n) RETURN n" }),
      cypher({ collectionId: otherGraph.id, cypher: "MATCH (n) RETURN n" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();

    expect(await results).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ ok: true }) },
      { status: "fulfilled", value: expect.objectContaining({ ok: true }) },
    ]);
    expect(maximumActive).toBe(2);
    expect(owners.size).toBe(0);
  });

  it("releases the graph queue after a failed query so the next tool call can run", async () => {
    const owners = useExclusiveCollectionLocks();
    const entered = deferred();
    const gate = deferred();
    speicher.cypherExecution.mockImplementation(async (_id, query) => {
      if (query === "MATCH (broken) RETURN broken") {
        entered.resolve();
        await gate.promise;
        throw new Error("Invalid graph query");
      }
    });
    const cypher = ausfuehren(baueCypherWerkzeug([graph]));
    const first = cypher({ cypher: "MATCH (broken) RETURN broken" });
    await entered.promise;
    const second = cypher({ cypher: "MATCH (valid) RETURN valid" });
    const results = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();

    expect(await results).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ ok: false, error: "Invalid graph query" }) },
      { status: "fulfilled", value: expect.objectContaining({ ok: true }) },
    ]);
    expect(speicher.cypherExecution).toHaveBeenCalledTimes(2);
    expect(owners.size).toBe(0);
  });

  it("aborts a queued graph call without waiting for the active query to finish", async () => {
    const owners = useExclusiveCollectionLocks();
    const entered = deferred();
    const gate = deferred();
    const controller = new AbortController();
    speicher.cypherExecution.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    const cypher = ausfuehren(baueCypherWerkzeug([graph], { signal: controller.signal }));
    const first = cypher({ cypher: "MATCH (first) RETURN first" });
    await entered.promise;
    const second = cypher({ cypher: "MATCH (second) RETURN second" });
    const results = Promise.allSettled([first, second]);
    let secondFinished = false;
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    controller.abort(new Error("Stopped by user"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const abortedWhileFirstStillRunning = secondFinished;
    gate.resolve();

    expect(await results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "Stopped by user" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "Stopped by user" }) },
    ]);
    expect(abortedWhileFirstStillRunning).toBe(true);
    expect(speicher.cypherExecution).toHaveBeenCalledTimes(1);
    expect(owners.size).toBe(0);
  });

  it("does not read a graph during an upload or rebuild and reports collection contention", async () => {
    speicher.lock.mockResolvedValue(false);
    const before = speicher.cypherCalls.length;
    const result = ausfuehren(baueCypherWerkzeug([graph]))({ cypher: "MATCH (n) RETURN n" });
    await expect(result).rejects.toBeInstanceOf(ResourceBusyError);
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining("Sammlung"), retryAfterSeconds: 5 });
    expect(speicher.cypherCalls).toHaveLength(before);
    expect(speicher.unlock).not.toHaveBeenCalled();
  });

  it("fails closed on graph lock infrastructure failure", async () => {
    speicher.lock.mockRejectedValue(new Error("Redis unavailable"));
    const before = speicher.cypherCalls.length;
    await expect(ausfuehren(baueCypherWerkzeug([graph]))({ cypher: "MATCH (n) RETURN n" })).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(speicher.cypherCalls).toHaveLength(before);
  });

  it("releases only its unique graph lock owner when the request aborts after acquisition", async () => {
    const controller = new AbortController();
    speicher.lock.mockImplementation(async () => { controller.abort(); return true; });
    const before = speicher.cypherCalls.length;
    await expect(ausfuehren(baueCypherWerkzeug([graph], { signal: controller.signal }))({ cypher: "MATCH (n) RETURN n" })).rejects.toThrow();
    expect(speicher.cypherCalls).toHaveLength(before);
    expect(speicher.unlock).toHaveBeenCalledExactlyOnceWith("wa:write:c-graph", speicher.lock.mock.calls[0][1]);
  });
});

describe("capRows", () => {
  it("laesst kleine Ergebnisse unangetastet", () => {
    expect(capRows([[1], [2]])).toEqual({ rows: [[1], [2]], capped: false });
  });

  it("kuerzt, bis das Ergebnis ins Zeichenbudget passt", () => {
    const zeile = ["x".repeat(1_000)];
    const rows = Array.from({ length: 100 }, () => zeile);
    const { rows: gekuerzt, capped } = capRows(rows);

    expect(capped).toBe(true);
    expect(gekuerzt.length).toBeLessThan(rows.length);
    expect(gekuerzt.length).toBeGreaterThan(0);
    expect(JSON.stringify(gekuerzt).length).toBeLessThanOrEqual(ERGEBNIS_MAX_ZEICHEN);
  });
});

describe("toStep", () => {
  it("bildet SQL-Aufrufe mit Vorschau fuer den Browser ab", () => {
    const step = toStep(
      [dokumente, tabellen],
      "sql_ausfuehren",
      { collectionId: tabellen.id, sql: "SELECT 1" },
      { ok: true, columns: ["x"], rows: [[1]], rowCount: 1, truncated: false },
    );

    expect(step).toEqual({
      tool: "sql_ausfuehren",
      collectionId: "c-sql",
      collectionName: "Umsatz",
      query: "SELECT 1",
      columns: ["x"],
      rowCount: 1,
      truncated: false,
      preview: [[1]],
    });
  });

  it("nimmt im Einzelmodus die gebundene Sammlung", () => {
    const step = toStep([graph], "cypher_ausfuehren", { cypher: "MATCH (n) RETURN n" }, {
      ok: true,
      columns: ["n"],
      rows: [],
      rowCount: 0,
      truncated: false,
    });
    expect(step?.collectionName).toBe("Netzwerk");
    expect(step?.preview).toEqual([]);
  });

  it("zeigt fuer die Suche nur die Trefferzahl, keine Vorschau", () => {
    const step = toStep(
      [dokumente, tabellen],
      "dokumente_durchsuchen",
      { collectionIds: [dokumente.id, tabellen.id], suchbegriff: "Gebuehren" },
      { hinweis: "…", abschnitte: [{ nummer: 1 }, { nummer: 2 }, { nummer: 3 }] },
    );

    expect(step).toMatchObject({
      tool: "dokumente_durchsuchen",
      collectionName: "Handbuch · Umsatz",
      query: "Gebuehren",
      rowCount: 3,
    });
    expect(step?.preview).toBeUndefined();
  });

  it("uebernimmt Fehler aus Ergebnis und Ausnahme", () => {
    const abgelehnt = toStep(
      [tabellen],
      "sql_ausfuehren",
      { sql: "DROP TABLE x" },
      { ok: false, error: "Nur lesende Abfragen." },
    );
    expect(abgelehnt?.error).toBe("Nur lesende Abfragen.");

    const ausnahme = toStep(
      [tabellen],
      "sql_ausfuehren",
      { sql: "SELECT 1" },
      undefined,
      new Error("Verbindung weg"),
    );
    expect(ausnahme?.error).toBe("Verbindung weg");
  });

  it("kennt fremde Werkzeugnamen nicht", () => {
    expect(toStep([tabellen], "run_sql", {}, {})).toBeNull();
  });
});
