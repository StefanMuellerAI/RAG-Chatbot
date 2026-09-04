import type { PresetId } from "./db/schema";
import { ValidationError } from "./errors";

/**
 * Verarbeitungspresets.
 *
 * Ein Nutzer soll bei der Anlage einer Sammlung genau eine einfache Frage
 * beantworten: "Was fuer Unterlagen kommen da rein?" Alles Weitere — Groesse
 * der Abschnitte, Ueberlappung, Schnittkanten, Anzahl der Treffer beim Abruf —
 * folgt daraus und wird ihm nicht zugemutet.
 *
 * Wer es genauer wissen will, kann im Expertenmodus des Anlegeformulars
 * einzelne Werte uebersteuern. Gespeichert wird dabei nur die Abweichung vom
 * Preset (collections.processing); `effektiveVerarbeitung` legt beides
 * uebereinander. Sammlungen ohne Abweichung folgen so weiterhin spaeteren
 * Anpassungen der Presets.
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

// --- Expertenmodus ----------------------------------------------------------

/**
 * Aehnlichkeitsschwelle, unter der ein Treffer als Rauschen gilt.
 *
 * NEU KALIBRIERT gegenueber dem Vorgaenger: Dort galt 0,35 fuer bge-m3 mit
 * Dot-Product. multilingual-e5-large arbeitet mit Cosine und legt seine Werte
 * deutlich hoeher und enger zusammen — auch inhaltlich unpassende Abschnitte
 * erreichen dort noch etwa 0,75. Der Wert unten trennt bei diesem Modell
 * zwischen "hat mit der Frage zu tun" und "ist nur auch deutscher Text".
 *
 * Liegt hier und nicht in lib/vector.ts, weil das Anlegeformular den Wert als
 * Vorgabe zeigt und dafuer nicht das Pinecone-SDK in den Browser ziehen soll.
 */
export const STANDARD_MIN_SCORE = 0.82;

/** Die Werte, die der Expertenmodus je Sammlung uebersteuern kann. */
export type VerarbeitungOverride = Partial<{
  zielGroesse: number;
  ueberlappung: number;
  topK: number;
  minScore: number;
}>;

export type VerarbeitungsFeld = keyof VerarbeitungOverride;

export const VERARBEITUNGS_FELDER: readonly VerarbeitungsFeld[] = [
  "zielGroesse",
  "ueberlappung",
  "topK",
  "minScore",
] as const;

/**
 * Was fuer eine Sammlung tatsaechlich gilt: das Preset mit den Abweichungen
 * darueber. `angepasst` sagt, ob ueberhaupt eine Abweichung hinterlegt ist.
 */
export type Verarbeitung = Preset & { minScore: number; angepasst: boolean };

/**
 * Zulaessige Bereiche.
 *
 * zielGroesse: multilingual-e5-large bettet hoechstens 512 Token ein; was
 *   darueber liegt, schneidet das Modell stillschweigend ab und der Rest des
 *   Abschnitts ist unauffindbar. 3.000 Zeichen deutscher Text liegen etwa an
 *   dieser Grenze. Unter 200 Zeichen traegt ein Abschnitt kaum noch eine
 *   Aussage.
 * ueberlappung: muss unter der halben Abschnittsgroesse bleiben. findeSchnitt
 *   schneidet fruehestens bei der Haelfte; eine groessere Ueberlappung liesse
 *   den naechsten Abschnitt vor dem Anfang des aktuellen beginnen, und die
 *   Schleife kroeche zeichenweise voran.
 * topK: Jeder Treffer landet im Kontext des Modells. Mehr als 30 je Sammlung
 *   sprengen bei mehreren Sammlungen den Prompt, ohne die Antwort zu tragen.
 * minScore: Cosine-Aehnlichkeit, 0 bis 1.
 */
export const VERARBEITUNG_GRENZEN = {
  zielGroesse: { min: 200, max: 3_000 },
  ueberlappung: { min: 0 },
  topK: { min: 1, max: 30 },
  minScore: { min: 0, max: 1 },
} as const;

/** Hoechste zulaessige Ueberlappung fuer eine Abschnittsgroesse. */
export function maxUeberlappung(zielGroesse: number): number {
  return Math.max(0, Math.ceil(zielGroesse / 2) - 1);
}

export function effektiveVerarbeitung(sammlung: {
  preset: string;
  processing?: VerarbeitungOverride | null;
}): Verarbeitung {
  const preset = findPreset(sammlung.preset);
  const abweichung = sammlung.processing ?? {};

  return {
    ...preset,
    zielGroesse: abweichung.zielGroesse ?? preset.zielGroesse,
    ueberlappung: abweichung.ueberlappung ?? preset.ueberlappung,
    topK: abweichung.topK ?? preset.topK,
    minScore: abweichung.minScore ?? STANDARD_MIN_SCORE,
    angepasst: VERARBEITUNGS_FELDER.some((feld) => abweichung[feld] !== undefined),
  };
}

/**
 * Prueft die Eingabe aus dem Expertenmodus und reduziert sie auf das, was vom
 * Preset abweicht.
 *
 * Ein Wert, der dem Preset entspricht, wird nicht gespeichert: Er waere sonst
 * eingefroren, waehrend Sammlungen ohne Abweichung einer spaeteren
 * Nachjustierung des Presets folgen. Bleibt nichts uebrig, kommt null zurueck
 * und die Sammlung ist eine gewoehnliche Preset-Sammlung.
 */
export function pruefeVerarbeitung(
  preset: Preset,
  eingabe: unknown,
): VerarbeitungOverride | null {
  if (eingabe === undefined || eingabe === null) return null;

  if (typeof eingabe !== "object" || Array.isArray(eingabe)) {
    throw new ValidationError("Die Einstellungen des Expertenmodus sind unlesbar.");
  }

  const roh = eingabe as Record<string, unknown>;

  const zielGroesse = ganzzahl(
    roh.zielGroesse,
    "Die Abschnittsgroesse",
    VERARBEITUNG_GRENZEN.zielGroesse.min,
    VERARBEITUNG_GRENZEN.zielGroesse.max,
    "Zeichen",
  );
  const ueberlappung = ganzzahl(
    roh.ueberlappung,
    "Die Ueberlappung",
    VERARBEITUNG_GRENZEN.ueberlappung.min,
    maxUeberlappung(VERARBEITUNG_GRENZEN.zielGroesse.max),
    "Zeichen",
  );

  // Die Kombination zaehlt, nicht der einzelne Wert: Wer nur die Groesse
  // verkleinert, behaelt die Ueberlappung des Presets — und die kann dann zu
  // gross fuer den neuen Abschnitt sein.
  const wirksameGroesse = zielGroesse ?? preset.zielGroesse;
  const wirksameUeberlappung = ueberlappung ?? preset.ueberlappung;
  if (wirksameUeberlappung > maxUeberlappung(wirksameGroesse)) {
    throw new ValidationError(
      `Die Ueberlappung (${wirksameUeberlappung.toLocaleString("de-DE")} Zeichen) muss unter ` +
        `der halben Abschnittsgroesse liegen — bei ${wirksameGroesse.toLocaleString("de-DE")} ` +
        `Zeichen sind das hoechstens ${maxUeberlappung(wirksameGroesse).toLocaleString("de-DE")}.`,
    );
  }

  const topK = ganzzahl(
    roh.topK,
    "Die Zahl der Treffer je Suche",
    VERARBEITUNG_GRENZEN.topK.min,
    VERARBEITUNG_GRENZEN.topK.max,
    "",
  );
  const minScore = dezimal(
    roh.minScore,
    "Die Mindest-Aehnlichkeit",
    VERARBEITUNG_GRENZEN.minScore.min,
    VERARBEITUNG_GRENZEN.minScore.max,
  );

  const abweichung: VerarbeitungOverride = {};
  if (zielGroesse !== undefined && zielGroesse !== preset.zielGroesse) {
    abweichung.zielGroesse = zielGroesse;
  }
  if (ueberlappung !== undefined && ueberlappung !== preset.ueberlappung) {
    abweichung.ueberlappung = ueberlappung;
  }
  if (topK !== undefined && topK !== preset.topK) {
    abweichung.topK = topK;
  }
  if (minScore !== undefined && minScore !== STANDARD_MIN_SCORE) {
    abweichung.minScore = minScore;
  }

  return Object.keys(abweichung).length > 0 ? abweichung : null;
}

/** Eine fehlende Angabe (undefined, null, "") heisst: Preset-Wert behalten. */
function fehlt(wert: unknown): boolean {
  return wert === undefined || wert === null || wert === "";
}

function alsZahl(wert: unknown, was: string): number {
  const zahl = typeof wert === "number" ? wert : Number(String(wert).replace(",", "."));
  if (!Number.isFinite(zahl)) {
    throw new ValidationError(`${was} muss eine Zahl sein.`);
  }
  return zahl;
}

function ganzzahl(
  wert: unknown,
  was: string,
  min: number,
  max: number,
  einheit: string,
): number | undefined {
  if (fehlt(wert)) return undefined;

  const zahl = alsZahl(wert, was);
  if (!Number.isInteger(zahl)) {
    throw new ValidationError(`${was} muss eine ganze Zahl sein.`);
  }
  if (zahl < min || zahl > max) {
    const nachsatz = einheit ? ` ${einheit}` : "";
    throw new ValidationError(
      `${was} muss zwischen ${min.toLocaleString("de-DE")} und ${max.toLocaleString("de-DE")}${nachsatz} liegen.`,
    );
  }
  return zahl;
}

function dezimal(wert: unknown, was: string, min: number, max: number): number | undefined {
  if (fehlt(wert)) return undefined;

  // Zwei Nachkommastellen: feiner laesst sich die Schwelle nicht sinnvoll
  // setzen, und 0,8200000001 als gespeicherte Abweichung waere Unsinn.
  const zahl = Math.round(alsZahl(wert, was) * 100) / 100;
  if (zahl < min || zahl > max) {
    throw new ValidationError(
      `${was} muss zwischen ${min.toLocaleString("de-DE")} und ${max.toLocaleString("de-DE")} liegen.`,
    );
  }
  return zahl;
}
