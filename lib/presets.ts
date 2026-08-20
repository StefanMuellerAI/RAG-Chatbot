import type { PresetId } from "./db/schema";

/**
 * Verarbeitungspresets.
 *
 * Ein Nutzer soll bei der Anlage einer Sammlung genau eine einfache Frage
 * beantworten: "Was fuer Unterlagen kommen da rein?" Alles Weitere — Groesse
 * der Abschnitte, Ueberlappung, Schnittkanten, Anzahl der Treffer beim Abruf —
 * folgt daraus und wird ihm nicht zugemutet.
 *
 * Warum das nicht ein Satz Werte fuer alles sein kann: Ein Zahlenblock aus der
 * Mitte einer Tabelle ist ohne die Kopfzeile bedeutungslos, ein Paragraph ohne
 * seine Ueberschrift nicht zuzuordnen, und ein Bericht in 500-Zeichen-Haeppchen
 * verliert den Zusammenhang, der die Antwort tragen soll.
 *
 * Das Preset gilt fuer die ganze Sammlung und nicht je Dokument. Sonst waeren
 * die Abschnitte innerhalb einer Sammlung unterschiedlich lang, und ihre
 * Aehnlichkeitswerte damit nicht mehr vergleichbar — die Rangfolge der Treffer
 * wuerde von der Abschnittslaenge abhaengen und nicht vom Inhalt.
 */

export type Schnittstrategie = "absatz" | "tabelle" | "gliederung";

export type Preset = {
  id: PresetId;
  label: string;
  /** Einzeiler auf der Auswahlkarte. */
  kurz: string;
  /** Woran der Nutzer erkennt, dass es das Richtige ist. */
  beispiele: string;
  strategie: Schnittstrategie;
  zielGroesse: number;
  ueberlappung: number;
  /**
   * Wie viele Abschnitte der Abruf holt. Kleine Abschnitte tragen einzeln
   * weniger Inhalt, deshalb braucht es mehr davon fuer dieselbe Antwort.
   */
  topK: number;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "fliesstext",
    label: "Fliesstext",
    kurz: "Zusammenhaengender Text in Absaetzen.",
    beispiele: "Berichte, Handbuecher, Protokolle, Konzepte, Informationsbroschueren",
    strategie: "absatz",
    zielGroesse: 1_200,
    ueberlappung: 200,
    topK: 8,
  },
  {
    id: "tabellen",
    label: "Tabellen und Zahlen",
    kurz: "Zeilen und Spalten, in denen die Kopfzeile die Bedeutung tragt.",
    beispiele: "Preislisten, Oeffnungszeiten, Gebuehrentabellen, Zustaendigkeiten, Statistiken",
    strategie: "tabelle",
    // Kleiner als beim Fliesstext, weil in jeden Abschnitt die Kopfzeile
    // wiederholt wird und der verbleibende Platz den Zeilen gehoeren soll.
    zielGroesse: 900,
    // Keine Ueberlappung: eine doppelt gefuehrte Tabellenzeile ist kein
    // gewonnener Zusammenhang, sondern ein zweiter Treffer mit gleichem Inhalt.
    ueberlappung: 0,
    topK: 12,
  },
  {
    id: "regelwerke",
    label: "Regelwerke",
    kurz: "Nummerierte Bestimmungen, bei denen es auf den Wortlaut ankommt.",
    beispiele: "Satzungen, Gesetze, Verordnungen, Vertraege, AGB, Dienstanweisungen",
    strategie: "gliederung",
    // Klein und praezise: gefragt wird nach einer einzelnen Bestimmung, nicht
    // nach dem Zusammenhang mehrerer Seiten.
    zielGroesse: 500,
    ueberlappung: 150,
    topK: 10,
  },
] as const;

export const STANDARD_PRESET: PresetId = "fliesstext";

export function findPreset(id: string): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0];
}

export function isPresetId(wert: unknown): wert is PresetId {
  return typeof wert === "string" && PRESETS.some((preset) => preset.id === wert);
}
