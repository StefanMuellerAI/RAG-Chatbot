import { ValidationError } from "./errors";

/**
 * Ontologie einer Graph-Sammlung: Welche Knotenarten (Labels) und
 * Beziehungstypen die Extraktion aus Dokumenten verwenden darf.
 *
 * Reine Konstanten und Pruefungen ohne Server-Abhaengigkeiten, damit das
 * Anlegeformular sie im Browser zeigen kann. Die Vorgabe deckt die Faelle ab,
 * die in Verwaltungs- und Unternehmensunterlagen fast immer vorkommen; wer
 * Vertraege, Bauteile oder Medikamente modelliert, ergaenzt eigene Typen.
 *
 * Die Herkunftsknoten (Quelle, Abschnitt) und ihre Kanten vergibt die
 * Anwendung selbst. Sie sind reserviert, damit eine eigene Ontologie sie
 * nicht ueberlagert — sonst liesse sich ein Beleg nicht mehr von einem
 * Inhalt unterscheiden.
 */

export type Ontologie = {
  /** Knotenarten, PascalCase, z. B. Person, Organisation. */
  labels: string[];
  /** Beziehungstypen, GROSS_MIT_UNTERSTRICH, z. B. ARBEITET_FUER. */
  beziehungen: string[];
  /** Darf das Modell weitere Labels und Beziehungstypen einfuehren? */
  frei: boolean;
};

/** Was fuer eine Graph-Sammlung in `collections.processing` steht. */
export type GraphVorgaben = { ontologie: Ontologie };

export const STANDARD_LABELS: readonly string[] = [
  "Person", "Organisation", "Ort", "Ereignis", "Vorschrift", "Begriff", "Datum", "Betrag",
];

export const STANDARD_BEZIEHUNGEN: readonly string[] = [
  "ARBEITET_FUER", "GEHOERT_ZU", "BEFINDET_SICH_IN", "BETEILIGT_AN", "BEZIEHT_SICH_AUF",
  "FINDET_STATT_AM", "GILT_AB", "HAT_BETRAG", "REGELT", "VERANTWORTLICH_FUER",
];

export const STANDARD_ONTOLOGIE: Ontologie = {
  labels: [...STANDARD_LABELS],
  beziehungen: [...STANDARD_BEZIEHUNGEN],
  frei: false,
};

/** Herkunft: je Datei ein Quelle-Knoten, je Textabschnitt ein Abschnitt-Knoten. */
export const PROVENIENZ = {
  quelle: "Quelle",
  abschnitt: "Abschnitt",
  erwaehntIn: "ERWAEHNT_IN",
  teilVon: "TEIL_VON",
} as const;

const RESERVIERT = new Set<string>(Object.values(PROVENIENZ));

export const ONTOLOGIE_MAX_EINTRAEGE = 40;
/** Labels und Typen landen unmaskiert im Cypher; deshalb nur Bezeichner. */
export const LABEL_MUSTER = /^[A-Z][A-Za-z0-9_]{0,39}$/;
export const BEZIEHUNG_MUSTER = /^[A-Z][A-Z0-9_]{0,39}$/;

/** Dokumentformate, die eine Graph-Sammlung mit Extraktion zusaetzlich annimmt. */
export const GRAPH_DOKUMENT_ENDUNGEN: readonly string[] = [".pdf", ".docx", ".xlsx"];

export function istGraphDokument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return GRAPH_DOKUMENT_ENDUNGEN.some((endung) => lower.endsWith(endung));
}

export function istGraphVorgaben(wert: unknown): wert is GraphVorgaben {
  return typeof wert === "object" && wert !== null && "ontologie" in wert;
}

/** Die Ontologie, die fuer eine Sammlung gilt — die Vorgabe, wenn keine hinterlegt ist. */
export function effektiveOntologie(sammlung: { processing?: unknown }): Ontologie {
  return istGraphVorgaben(sammlung.processing) ? sammlung.processing.ontologie : STANDARD_ONTOLOGIE;
}

/**
 * Prueft eine Ontologie aus dem Formular. Listen kommen als Array oder als
 * Text mit Kommas oder Zeilenumbruechen. Doppelte werden entfernt, die
 * Reihenfolge bleibt — sie ist die Reihenfolge im Prompt.
 */
export function pruefeOntologie(roh: unknown): Ontologie {
  if (typeof roh !== "object" || roh === null) {
    throw new ValidationError("Die Ontologie fehlt oder ist unlesbar.");
  }
  const eingabe = roh as { labels?: unknown; beziehungen?: unknown; frei?: unknown };

  const labels = liste(eingabe.labels);
  const beziehungen = liste(eingabe.beziehungen);

  if (labels.length === 0) {
    throw new ValidationError("Mindestens eine Knotenart ist noetig, z. B. Person.");
  }
  if (labels.length > ONTOLOGIE_MAX_EINTRAEGE || beziehungen.length > ONTOLOGIE_MAX_EINTRAEGE) {
    throw new ValidationError(`Hoechstens ${ONTOLOGIE_MAX_EINTRAEGE} Knotenarten und ${ONTOLOGIE_MAX_EINTRAEGE} Beziehungstypen.`);
  }
  for (const label of labels) {
    if (!LABEL_MUSTER.test(label)) {
      throw new ValidationError(
        `Knotenart „${label}“ ist ungueltig: Grossbuchstabe am Anfang, dann Buchstaben, Ziffern oder Unterstrich, ohne Umlaute (z. B. Organisation).`,
      );
    }
    if (RESERVIERT.has(label)) {
      throw new ValidationError(`„${label}“ ist fuer die Herkunftsangaben reserviert.`);
    }
  }
  for (const typ of beziehungen) {
    if (!BEZIEHUNG_MUSTER.test(typ)) {
      throw new ValidationError(
        `Beziehungstyp „${typ}“ ist ungueltig: Grossbuchstaben, Ziffern und Unterstrich, ohne Umlaute (z. B. ARBEITET_FUER).`,
      );
    }
    if (RESERVIERT.has(typ)) {
      throw new ValidationError(`„${typ}“ ist fuer die Herkunftsangaben reserviert.`);
    }
  }

  const frei = eingabe.frei === true || eingabe.frei === "true" || eingabe.frei === "1";
  return { labels, beziehungen, frei };
}

/** true, wenn die Ontologie der Vorgabe entspricht — dann wird nichts gespeichert. */
export function istStandardOntologie(ontologie: Ontologie): boolean {
  return (
    !ontologie.frei &&
    ontologie.labels.join(",") === STANDARD_LABELS.join(",") &&
    ontologie.beziehungen.join(",") === STANDARD_BEZIEHUNGEN.join(",")
  );
}

function liste(wert: unknown): string[] {
  const roh: unknown[] = Array.isArray(wert) ? wert : typeof wert === "string" ? wert.split(/[,\n;]/) : [];
  const gesehen = new Set<string>();
  const ergebnis: string[] = [];
  for (const eintrag of roh) {
    const text = String(eintrag ?? "").trim();
    if (!text || gesehen.has(text)) continue;
    gesehen.add(text);
    ergebnis.push(text);
  }
  return ergebnis;
}

/** Fuer Formularfelder: eine Liste als Zeilen. */
export function alsZeilen(eintraege: readonly string[]): string {
  return eintraege.join("\n");
}
