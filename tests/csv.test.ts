import { describe, expect, it } from "vitest";
import { inferType, parseCsv, tableNameFromFilename, toIdentifier, toNumber } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";

const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("parseCsv", () => {
  it("liest deutsche CSVs mit Semikolon, Dezimalkomma und BOM", () => {
    const csv = "\uFEFFArtikel;Preis (EUR);Menge;Datum\nSchraube;1.234,50;12;2026-01-03\nMutter;0,99;;2026-01-04\n";
    const { columns, rows } = parseCsv(enc(csv));

    expect(columns).toEqual([
      { name: "artikel", type: "TEXT" },
      { name: "preis_eur", type: "REAL" },
      { name: "menge", type: "INTEGER" },
      { name: "datum", type: "TEXT" },
    ]);
    expect(rows).toEqual([
      ["Schraube", 1234.5, 12, "2026-01-03"],
      ["Mutter", 0.99, null, "2026-01-04"],
    ]);
  });

  it("liest englische CSVs mit Komma und Punkt", () => {
    const { columns, rows } = parseCsv(enc("id,amount,note\n1,10.5,\"a, b\"\n2,3,x\n"));
    expect(columns.map((c) => c.type)).toEqual(["INTEGER", "REAL", "TEXT"]);
    expect(rows[0]).toEqual([1, 10.5, "a, b"]);
  });

  it("macht doppelte und unsichere Spaltennamen eindeutig", () => {
    const { columns } = parseCsv(enc("Name;Name;1. Wert;select\nx;y;1;2\n"));
    expect(columns.map((c) => c.name)).toEqual(["name", "name_2", "c_1_wert", "select_"]);
  });

  it("lehnt Dateien ohne Daten ab", () => {
    expect(() => parseCsv(enc("nur;kopf\n"))).toThrow(ValidationError);
    expect(() => parseCsv(enc(""))).toThrow(ValidationError);
  });
});

describe("Hilfsfunktionen", () => {
  it("inferiert den engsten Typ", () => {
    expect(inferType(["1", "2", null])).toBe("INTEGER");
    expect(inferType(["1", "2,5"])).toBe("REAL");
    expect(inferType(["1", "x"])).toBe("TEXT");
    expect(inferType([null, null])).toBe("TEXT");
  });

  it("wandelt Zahlen beider Schreibweisen", () => {
    expect(toNumber("1.234,56")).toBe(1234.56);
    expect(toNumber("1,234.56")).toBe(1234.56);
    expect(toNumber("42")).toBe(42);
    expect(toNumber("abc")).toBeNull();
  });

  it("bildet Bezeichner und Tabellennamen", () => {
    expect(toIdentifier("Straße / Nr.")).toBe("strasse_nr");
    expect(toIdentifier("")).toBe("spalte");
    expect(tableNameFromFilename("Umsatz 2025.CSV")).toBe("umsatz_2025");
  });
});
