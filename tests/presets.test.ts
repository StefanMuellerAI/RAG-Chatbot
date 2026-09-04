import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  STANDARD_MIN_SCORE,
  effektiveVerarbeitung,
  findPreset,
  maxUeberlappung,
  pruefeVerarbeitung,
} from "@/lib/presets";

/**
 * Der Expertenmodus speichert nur Abweichungen vom Preset. Geprueft wird
 * hier beides: dass die Aufloesung Preset und Abweichung richtig uebereinander
 * legt, und dass die Pruefung unbrauchbare Werte abweist, statt sie in die
 * Sammlung zu schreiben — dort liessen sie sich nicht mehr korrigieren.
 */
const FLIESSTEXT = findPreset("fliesstext");

describe("effektiveVerarbeitung", () => {
  it("liefert ohne Abweichung die Werte des Presets und die Standardschwelle", () => {
    const verarbeitung = effektiveVerarbeitung({ preset: "fliesstext", processing: null });
    expect(verarbeitung.zielGroesse).toBe(FLIESSTEXT.zielGroesse);
    expect(verarbeitung.ueberlappung).toBe(FLIESSTEXT.ueberlappung);
    expect(verarbeitung.topK).toBe(FLIESSTEXT.topK);
    expect(verarbeitung.minScore).toBe(STANDARD_MIN_SCORE);
    expect(verarbeitung.angepasst).toBe(false);
    expect(verarbeitung.label).toBe(FLIESSTEXT.label);
  });

  it("legt einzelne Abweichungen ueber das Preset und laesst den Rest stehen", () => {
    const verarbeitung = effektiveVerarbeitung({
      preset: "regelwerke",
      processing: { zielGroesse: 800, minScore: 0.7 },
    });
    const regelwerke = findPreset("regelwerke");
    expect(verarbeitung.zielGroesse).toBe(800);
    expect(verarbeitung.minScore).toBe(0.7);
    expect(verarbeitung.ueberlappung).toBe(regelwerke.ueberlappung);
    expect(verarbeitung.topK).toBe(regelwerke.topK);
    expect(verarbeitung.strategie).toBe("gliederung");
    expect(verarbeitung.angepasst).toBe(true);
  });

  it("kommt mit einer Sammlung ohne processing-Feld zurecht", () => {
    expect(effektiveVerarbeitung({ preset: "tabellen" }).angepasst).toBe(false);
  });
});

describe("pruefeVerarbeitung", () => {
  it("ergibt null, wenn nichts oder nur Preset-Werte uebergeben werden", () => {
    expect(pruefeVerarbeitung(FLIESSTEXT, undefined)).toBeNull();
    expect(pruefeVerarbeitung(FLIESSTEXT, null)).toBeNull();
    expect(pruefeVerarbeitung(FLIESSTEXT, {})).toBeNull();
    expect(
      pruefeVerarbeitung(FLIESSTEXT, {
        zielGroesse: FLIESSTEXT.zielGroesse,
        ueberlappung: FLIESSTEXT.ueberlappung,
        topK: FLIESSTEXT.topK,
        minScore: STANDARD_MIN_SCORE,
      }),
    ).toBeNull();
  });

  it("behaelt nur die Werte, die vom Preset abweichen", () => {
    expect(
      pruefeVerarbeitung(FLIESSTEXT, {
        zielGroesse: 800,
        ueberlappung: FLIESSTEXT.ueberlappung,
        topK: 5,
        minScore: STANDARD_MIN_SCORE,
      }),
    ).toEqual({ zielGroesse: 800, topK: 5 });
  });

  it("nimmt Zahlen auch als Text und mit Dezimalkomma an", () => {
    expect(
      pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: "900", minScore: "0,75" }),
    ).toEqual({ zielGroesse: 900, minScore: 0.75 });
  });

  it("rundet die Schwelle auf zwei Nachkommastellen", () => {
    expect(pruefeVerarbeitung(FLIESSTEXT, { minScore: 0.8449 })).toEqual({ minScore: 0.84 });
    // Rundet es auf den Standard, bleibt keine Abweichung uebrig.
    expect(pruefeVerarbeitung(FLIESSTEXT, { minScore: 0.8201 })).toBeNull();
  });

  it("weist Werte ausserhalb der Grenzen ab", () => {
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 100 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 5_000 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { ueberlappung: -1 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { topK: 0 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { topK: 31 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { minScore: 1.2 })).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { minScore: -0.1 })).toThrow(ValidationError);
  });

  it("verlangt ganze Zahlen fuer Groesse, Ueberlappung und Treffer", () => {
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 800.5 })).toThrow(
      /ganze Zahl/,
    );
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { topK: "acht" })).toThrow(/Zahl/);
  });

  it("weist eine Ueberlappung ab, die die halbe Abschnittsgroesse erreicht", () => {
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 400, ueberlappung: 200 })).toThrow(
      /halben Abschnittsgroesse/,
    );
    expect(
      pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 400, ueberlappung: maxUeberlappung(400) }),
    ).toEqual({ zielGroesse: 400, ueberlappung: 199 });
  });

  it("prueft die Ueberlappung des Presets gegen eine verkleinerte Abschnittsgroesse", () => {
    // Fliesstext bringt 200 Zeichen Ueberlappung mit; bei 300 Zeichen
    // Abschnittsgroesse waere das mehr als die Haelfte.
    expect(() => pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 300 })).toThrow(
      /halben Abschnittsgroesse/,
    );
    expect(pruefeVerarbeitung(FLIESSTEXT, { zielGroesse: 300, ueberlappung: 60 })).toEqual({
      zielGroesse: 300,
      ueberlappung: 60,
    });
  });

  it("weist unlesbare Eingaben ab", () => {
    expect(() => pruefeVerarbeitung(FLIESSTEXT, "gross")).toThrow(ValidationError);
    expect(() => pruefeVerarbeitung(FLIESSTEXT, [1_200, 200])).toThrow(ValidationError);
  });
});
