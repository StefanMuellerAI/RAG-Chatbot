import { beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  assertReadOnlySql,
  databasePath,
  describeSchema,
  dropTable,
  listTables,
  newDatabase,
  replaceTable,
  runReadOnlyQuery,
  sqlJsDiagnose,
} from "@/lib/sqlstore";

type Db = Awaited<ReturnType<typeof newDatabase>>;
let db: Db;

beforeAll(async () => {
  db = await newDatabase();
  replaceTable(
    db,
    "umsatz",
    [
      { name: "id", type: "INTEGER" },
      { name: "kunde", type: "TEXT" },
      { name: "betrag", type: "REAL" },
    ],
    [
      [1, "Alpha", 10.5],
      [2, "Beta", 20],
      [3, "Alpha", 5.25],
    ],
  );
});

describe("Blob-Pfad", () => {
  it("liegt im Mandantenpraefix der Sammlung", () => {
    expect(databasePath("user_1", "coll_1")).toBe("files/user_1/coll_1/_db/sammlung.sqlite");
  });
});

describe("Diagnose", () => {
  it("meldet die geladene SQLite-Version", async () => {
    const diagnose = await sqlJsDiagnose();
    expect(diagnose.ok).toBe(true);
    if (diagnose.ok) expect(diagnose.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("Tabellen und Schema", () => {
  it("baut Tabellen und beschreibt sie", () => {
    const schema = describeSchema(db);
    expect(schema.kind).toBe("sql");
    if (schema.kind !== "sql") return;
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0]).toMatchObject({
      name: "umsatz",
      rows: 3,
      columns: [
        { name: "id", type: "INTEGER" },
        { name: "kunde", type: "TEXT" },
        { name: "betrag", type: "REAL" },
      ],
    });
    expect(schema.tables[0].samples?.kunde).toEqual(["Alpha", "Beta"]);
  });

  it("ersetzt eine Tabelle vollstaendig", () => {
    replaceTable(db, "klein", [{ name: "a", type: "INTEGER" }], [[1], [2]]);
    replaceTable(db, "klein", [{ name: "b", type: "TEXT" }], [["x"]]);
    const result = runReadOnlyQuery(db, "SELECT * FROM klein");
    expect(result.columns).toEqual(["b"]);
    expect(result.rows).toEqual([["x"]]);
    dropTable(db, "klein");
    expect(listTables(db)).toEqual(["umsatz"]);
  });

  it("lehnt ungueltige Bezeichner ab", () => {
    expect(() => replaceTable(db, "Boese Tabelle", [{ name: "a", type: "TEXT" }], [])).toThrow(
      ValidationError,
    );
    expect(() => dropTable(db, 'x"; DROP TABLE umsatz; --')).toThrow(ValidationError);
  });
});

describe("Lesende Abfragen", () => {
  it("fuehrt SELECT und WITH aus und begrenzt die Zeilen", () => {
    const summe = runReadOnlyQuery(
      db,
      "SELECT kunde, SUM(betrag) AS gesamt FROM umsatz GROUP BY kunde ORDER BY kunde;",
    );
    expect(summe.rows).toEqual([
      ["Alpha", 15.75],
      ["Beta", 20],
    ]);

    const cte = runReadOnlyQuery(
      db,
      "WITH a AS (SELECT * FROM umsatz WHERE betrag > 6) SELECT COUNT(*) FROM a",
    );
    expect(cte.rows[0][0]).toBe(2);

    replaceTable(
      db,
      "viele",
      [{ name: "n", type: "INTEGER" }],
      Array.from({ length: 250 }, (_, i) => [i]),
    );
    const begrenzt = runReadOnlyQuery(db, "SELECT n FROM viele");
    expect(begrenzt.rowCount).toBe(200);
    expect(begrenzt.truncated).toBe(true);
    dropTable(db, "viele");
  });

  it("laesst Funktionen wie replace() zu, aber keine Schreibbefehle", () => {
    expect(assertReadOnlySql("SELECT replace(kunde, 'a', 'b') FROM umsatz")).toContain(
      "replace(",
    );
    for (const boese of [
      "DROP TABLE umsatz",
      "SELECT 1; DROP TABLE umsatz",
      "PRAGMA table_info(umsatz)",
      "INSERT INTO umsatz VALUES (9, 'x', 1)",
      "SELECT * FROM umsatz; --",
      "ATTACH DATABASE 'x' AS y",
      "WITH a AS (SELECT 1) DELETE FROM umsatz",
      "",
    ]) {
      expect(() => assertReadOnlySql(boese), boese).toThrow(ValidationError);
    }
  });

  it("ignoriert Schluesselwoerter in String-Literalen und Kommentaren", () => {
    expect(() =>
      assertReadOnlySql("SELECT 'drop table x' AS t FROM umsatz -- update nichts"),
    ).not.toThrow();
  });

  it("meldet SQL-Fehler als verwertbare Meldung", () => {
    expect(() => runReadOnlyQuery(db, "SELECT gibtsnicht FROM umsatz")).toThrow(/SQL-Fehler/);
  });
});
