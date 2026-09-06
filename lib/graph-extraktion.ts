import { z } from "zod";
import { chunkBlocks } from "./chunk";
import { optionalEnv } from "./env";
import { ValidationError } from "./errors";
import type { ExtractedBlock } from "./extract";
import {
  BEZIEHUNG_MUSTER,
  LABEL_MUSTER,
  PROVENIENZ,
  type Ontologie,
} from "./graph-ontologie";
import { findPreset, type Preset } from "./presets";
import type { UpsertChunk } from "./vector";

/**
 * Graph-Extraktion: Aus Dokumenten (PDF, DOCX, XLSX) werden Knoten und
 * Kanten gewonnen, die in den Graphen der Sammlung wandern — neben oder
 * statt hochgeladener Cypher-Skripte.
 *
 * Das Modell liefert nie Cypher, sondern JSON: Knoten mit Label und Name,
 * Kanten zwischen ihnen. Aus dem JSON entsteht deterministisch ein
 * parametrisierter UNWIND-Import (lib/graphstore.ts). So kann eine
 * Modellantwort weder Schreibbefehle einschleusen noch den Graphen einer
 * anderen Sammlung erreichen, und ein Neuaufbau spielt exakt dasselbe
 * Ergebnis wieder ein, ohne das Modell erneut zu fragen.
 *
 * Eingeschaltet wird die Extraktion ueber GRAPH_EXTRAKTION_MODELL (eine
 * Modellkennung des Katalogs). Ohne die Variable nehmen Graph-Sammlungen
 * weiterhin nur Cypher-Skripte an.
 */

export function graphExtraktionModell(): string | undefined {
  return optionalEnv("GRAPH_EXTRAKTION_MODELL")?.trim() || undefined;
}

export function graphExtraktionKonfiguriert(): boolean {
  return graphExtraktionModell() !== undefined;
}

/**
 * Ein Modellaufruf je Abschnitt; 300 Seiten sind etwa 500 Aufrufe.
 *
 * Bewusst ohne lib/capacity.ts: Dieses Modul haengt am Workflow-Bundle
 * (verarbeiteGraphDokument liest EXTRAKTION_JE_SCHRITT), und dort sind
 * Node-Module wie node:crypto nicht erlaubt.
 */
export function graphExtraktionMaxSeiten(): number {
  const roh = process.env.GRAPH_EXTRAKTION_MAX_SEITEN;
  if (!roh) return 300;
  const wert = Number(roh);
  if (!Number.isSafeInteger(wert) || wert <= 0 || wert > 5_000) {
    throw new Error("GRAPH_EXTRAKTION_MAX_SEITEN muss eine ganze Zahl zwischen 1 und 5000 sein.");
  }
  return wert;
}

/** Antworten des Modells sind klein; die Grenze faengt nur Ausreisser ab. */
export const EXTRAKTION_MAX_AUSGABE_TOKENS = 4_000;
/** Hoechstens so viele Abschnitte je Workflow-Schritt, damit ein Schritt unter der Frist bleibt. */
export const EXTRAKTION_JE_SCHRITT = 6;

/**
 * Abschnitte fuer die Extraktion: groesser als fuer die Suche, ohne
 * Ueberlappung. Ein doppelt gelesener Satz ergaebe dieselben Knoten zweimal —
 * harmlos fuer MERGE, aber verlorene Modellzeit.
 */
export const EXTRAKTION_PRESET: Preset = {
  ...findPreset("fliesstext"),
  zielGroesse: 2_000,
  ueberlappung: 0,
};

export function abschnitteFuerExtraktion(bloecke: ExtractedBlock[]): UpsertChunk[] {
  return chunkBlocks(bloecke, EXTRAKTION_PRESET);
}

// ---------------------------------------------------------------------------
// Artefakte im Dokumentordner
// ---------------------------------------------------------------------------

/** Die zerlegten Abschnitte, damit jeder Schritt seinen Teil lesen kann. */
export const ABSCHNITTE_ARTEFAKT = "_abschnitte.json";
/** Das zusammengefuehrte Ergebnis; Grundlage jedes Neuaufbaus. */
export const GRAPH_ARTEFAKT = "_graph.json";

function dokumentOrdner(blobPath: string): string {
  const index = blobPath.lastIndexOf("/");
  return index < 0 ? "" : blobPath.slice(0, index + 1);
}

export function abschnitteArtefaktPfad(blobPath: string): string {
  return `${dokumentOrdner(blobPath)}${ABSCHNITTE_ARTEFAKT}`;
}

export function graphArtefaktPfad(blobPath: string): string {
  return `${dokumentOrdner(blobPath)}${GRAPH_ARTEFAKT}`;
}

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------

export type GraphKnoten = {
  /** `Label:name in Kleinschreibung` — der Schluessel, unter dem MERGE zusammenfuehrt. */
  schluessel: string;
  label: string;
  name: string;
  beschreibung?: string;
  /** Nummern der Abschnitte, in denen der Knoten vorkommt. */
  abschnitte: number[];
};

export type GraphKante = {
  von: string;
  vonLabel: string;
  typ: string;
  nach: string;
  nachLabel: string;
  abschnitte: number[];
};

export type GraphAbschnitt = {
  nummer: number;
  fundstelle: string | null;
  auszug: string;
};

/** Das Ergebnis eines Dokuments, so wie es als `_graph.json` liegt. */
export type GraphDaten = {
  version: 1;
  docId: string;
  filename: string;
  knoten: GraphKnoten[];
  kanten: GraphKante[];
  abschnitte: GraphAbschnitt[];
};

/** Was ein Extraktionsschritt zurueckgibt — klein genug fuer den Ablaufspeicher. */
export type Teilergebnis = {
  knoten: GraphKnoten[];
  kanten: GraphKante[];
  abschnitte: GraphAbschnitt[];
  /** Nummern der Abschnitte, deren Antwort nicht lesbar war. */
  fehlgeschlagen: number[];
  /** Knoten und Kanten, die ausserhalb der Ontologie lagen oder kein Ziel hatten. */
  verworfen: number;
};

export type Extraktionsabschnitt = { nummer: number; text: string; location?: string };

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const AUSZUG_ZEICHEN = 240;
const NAME_MAX_ZEICHEN = 160;
const BESCHREIBUNG_MAX_ZEICHEN = 300;

export function baueExtraktionsPrompt(
  ontologie: Ontologie,
  abschnitt: Extraktionsabschnitt,
  quelle: { filename: string },
): { instructions: string; prompt: string } {
  const instructions =
    `Du extrahierst aus einem Textabschnitt einen Wissensgraphen: benannte Entitaeten als Knoten und ` +
    `ihre Beziehungen als Kanten. Antworte ausschliesslich mit einem JSON-Objekt, ohne Erklaerung und ohne Codeblock.\n\n` +
    `Format:\n` +
    `{"knoten":[{"label":"Person","name":"Max Mustermann","beschreibung":"Leiter des Ordnungsamts"}],` +
    `"kanten":[{"von":"Max Mustermann","typ":"ARBEITET_FUER","nach":"Stadt Musterstadt"}]}\n\n` +
    `Regeln:\n` +
    `- Erlaubte Knotenarten (label): ${ontologie.labels.join(", ")}.\n` +
    `- Erlaubte Beziehungstypen (typ): ${ontologie.beziehungen.join(", ") || "keine vorgegeben"}.\n` +
    (ontologie.frei
      ? `- Passt nichts davon, darfst du eine weitere Knotenart (Grossbuchstabe am Anfang, z. B. Bauteil) oder einen weiteren Beziehungstyp (GROSSBUCHSTABEN_MIT_UNTERSTRICH) einfuehren.\n`
      : `- Andere Knotenarten und Beziehungstypen sind nicht erlaubt; was nicht passt, laesst du weg.\n`) +
    `- name ist die kanonische Bezeichnung, wie sie im Text steht: vollstaendige Namen, offizielle Bezeichnungen, Daten als Text (z. B. "12. Maerz 2024"), Betraege mit Einheit.\n` +
    `- Dieselbe Entitaet bekommt im ganzen Abschnitt genau einen Knoten mit genau einem Namen.\n` +
    `- "von" und "nach" einer Kante muessen exakt einem name aus knoten entsprechen.\n` +
    `- beschreibung ist optional: ein kurzer Satz aus dem Text, keine Vermutung.\n` +
    `- Erfinde nichts. Allgemeine Woerter ohne Eigennamen (z. B. "der Antragsteller") sind keine Knoten.\n` +
    `- Enthaelt der Abschnitt keine Entitaeten, antworte mit {"knoten":[],"kanten":[]}.`;

  const prompt =
    `Datei: ${quelle.filename}\n` +
    (abschnitt.location ? `Fundstelle: ${abschnitt.location}\n` : "") +
    `Abschnitt ${abschnitt.nummer}:\n\n${abschnitt.text}`;

  return { instructions, prompt };
}

// ---------------------------------------------------------------------------
// Antwort lesen
// ---------------------------------------------------------------------------

const antwortSchema = z.object({
  knoten: z
    .array(z.object({ label: z.string(), name: z.string(), beschreibung: z.string().nullish() }))
    .default([]),
  kanten: z.array(z.object({ von: z.string(), typ: z.string(), nach: z.string() })).default([]),
});

/** Kleinschreibung, ein Leerzeichen, ohne Satzzeichen am Rand. */
export function normalisiereName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'„“‚‘(]+|[\s"'“”‘’).,;:]+$/g, "")
    .toLowerCase();
}

export function knotenSchluessel(label: string, name: string): string {
  return `${label}:${normalisiereName(name)}`;
}

function saubererName(roh: string): string | null {
  const name = roh.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, NAME_MAX_ZEICHEN);
  return normalisiereName(name).length >= 1 ? name : null;
}

function alsLabel(roh: string, ontologie: Ontologie): string | null {
  const text = roh.trim();
  const bekannt = ontologie.labels.find((label) => label.toLowerCase() === text.toLowerCase());
  if (bekannt) return bekannt;
  if (!ontologie.frei) return null;
  const kandidat = text.replace(/[^A-Za-z0-9_]/g, "");
  const label = kandidat.charAt(0).toUpperCase() + kandidat.slice(1);
  return LABEL_MUSTER.test(label) && !istReserviert(label) ? label : null;
}

function alsBeziehung(roh: string, ontologie: Ontologie): string | null {
  const text = roh.trim().toUpperCase().replace(/[\s-]+/g, "_").replace(/[^A-Z0-9_]/g, "");
  const bekannt = ontologie.beziehungen.find((typ) => typ === text);
  if (bekannt) return bekannt;
  if (!ontologie.frei) return null;
  return BEZIEHUNG_MUSTER.test(text) && !istReserviert(text) ? text : null;
}

function istReserviert(bezeichner: string): boolean {
  return (Object.values(PROVENIENZ) as string[]).includes(bezeichner);
}

/** Holt das JSON-Objekt aus einer Antwort, auch wenn ein Codeblock darum steht. */
export function jsonAusAntwort(text: string): unknown {
  const ohneZaun = text.replace(/```(?:json)?/gi, "").trim();
  const anfang = ohneZaun.indexOf("{");
  const ende = ohneZaun.lastIndexOf("}");
  if (anfang < 0 || ende <= anfang) {
    throw new ValidationError("Die Modellantwort enthaelt kein JSON-Objekt.");
  }
  try {
    return JSON.parse(ohneZaun.slice(anfang, ende + 1));
  } catch {
    throw new ValidationError("Die Modellantwort ist kein gueltiges JSON.");
  }
}

/**
 * Liest die Antwort zu einem Abschnitt und bringt sie in die Form, die der
 * Import braucht. Alles ausserhalb der Ontologie faellt weg, Kanten ohne
 * bekannte Endpunkte ebenfalls; die Zahl der verworfenen Eintraege wandert
 * ins Log, damit eine schlecht passende Ontologie auffaellt.
 */
export function leseExtraktion(
  antwort: string,
  ontologie: Ontologie,
  abschnitt: Extraktionsabschnitt,
): Teilergebnis {
  const gelesen = antwortSchema.safeParse(jsonAusAntwort(antwort));
  if (!gelesen.success) {
    throw new ValidationError("Die Modellantwort hat nicht das erwartete Format.");
  }

  let verworfen = 0;
  const knoten = new Map<string, GraphKnoten>();
  /** Name in Kleinschreibung → Schluessel, um Kanten aufzuloesen. */
  const nachName = new Map<string, string>();

  for (const eintrag of gelesen.data.knoten) {
    const label = alsLabel(eintrag.label, ontologie);
    const name = saubererName(eintrag.name);
    if (!label || !name) { verworfen += 1; continue; }
    const schluessel = knotenSchluessel(label, name);
    const beschreibung = eintrag.beschreibung?.replace(/\s+/g, " ").trim().slice(0, BESCHREIBUNG_MAX_ZEICHEN) || undefined;
    const vorhanden = knoten.get(schluessel);
    if (vorhanden) {
      if (beschreibung && (!vorhanden.beschreibung || beschreibung.length > vorhanden.beschreibung.length)) {
        vorhanden.beschreibung = beschreibung;
      }
    } else {
      knoten.set(schluessel, { schluessel, label, name, ...(beschreibung ? { beschreibung } : {}), abschnitte: [abschnitt.nummer] });
    }
    nachName.set(normalisiereName(name), schluessel);
  }

  const kanten = new Map<string, GraphKante>();
  for (const eintrag of gelesen.data.kanten) {
    const typ = alsBeziehung(eintrag.typ, ontologie);
    const von = nachName.get(normalisiereName(eintrag.von));
    const nach = nachName.get(normalisiereName(eintrag.nach));
    if (!typ || !von || !nach || von === nach) { verworfen += 1; continue; }
    const id = `${von}|${typ}|${nach}`;
    if (kanten.has(id)) continue;
    kanten.set(id, {
      von, vonLabel: knoten.get(von)!.label, typ, nach, nachLabel: knoten.get(nach)!.label,
      abschnitte: [abschnitt.nummer],
    });
  }

  return {
    knoten: [...knoten.values()],
    kanten: [...kanten.values()],
    abschnitte: [{
      nummer: abschnitt.nummer,
      fundstelle: abschnitt.location ?? null,
      auszug: abschnitt.text.replace(/\s+/g, " ").trim().slice(0, AUSZUG_ZEICHEN),
    }],
    fehlgeschlagen: [],
    verworfen,
  };
}

// ---------------------------------------------------------------------------
// Zusammenfuehren
// ---------------------------------------------------------------------------

/** Fuehrt Teilergebnisse zusammen: gleiche Schluessel werden ein Knoten, gleiche Kanten eine Kante. */
export function verschmelze(teile: Teilergebnis[]): Teilergebnis {
  const knoten = new Map<string, GraphKnoten>();
  const kanten = new Map<string, GraphKante>();
  const abschnitte: GraphAbschnitt[] = [];
  const fehlgeschlagen: number[] = [];
  let verworfen = 0;

  for (const teil of teile) {
    for (const k of teil.knoten) {
      const vorhanden = knoten.get(k.schluessel);
      if (!vorhanden) {
        knoten.set(k.schluessel, { ...k, abschnitte: [...k.abschnitte] });
        continue;
      }
      for (const nummer of k.abschnitte) if (!vorhanden.abschnitte.includes(nummer)) vorhanden.abschnitte.push(nummer);
      if (k.beschreibung && (!vorhanden.beschreibung || k.beschreibung.length > vorhanden.beschreibung.length)) {
        vorhanden.beschreibung = k.beschreibung;
      }
    }
    for (const k of teil.kanten) {
      const id = `${k.von}|${k.typ}|${k.nach}`;
      const vorhanden = kanten.get(id);
      if (!vorhanden) {
        kanten.set(id, { ...k, abschnitte: [...k.abschnitte] });
        continue;
      }
      for (const nummer of k.abschnitte) if (!vorhanden.abschnitte.includes(nummer)) vorhanden.abschnitte.push(nummer);
    }
    abschnitte.push(...teil.abschnitte);
    fehlgeschlagen.push(...teil.fehlgeschlagen);
    verworfen += teil.verworfen;
  }

  abschnitte.sort((a, b) => a.nummer - b.nummer);
  return { knoten: [...knoten.values()], kanten: [...kanten.values()], abschnitte, fehlgeschlagen, verworfen };
}

export function fuegeGraphteileZusammen(
  teile: Teilergebnis[],
  quelle: { docId: string; filename: string },
): GraphDaten {
  const gesamt = verschmelze(teile);
  return {
    version: 1,
    docId: quelle.docId,
    filename: quelle.filename,
    knoten: gesamt.knoten,
    kanten: gesamt.kanten,
    abschnitte: gesamt.abschnitte,
  };
}

/** Liest ein `_graph.json`; eine fremde oder alte Fassung wird abgelehnt statt halb eingespielt. */
export function leseGraphDaten(text: string): GraphDaten {
  const daten = JSON.parse(text) as Partial<GraphDaten>;
  if (daten.version !== 1 || typeof daten.docId !== "string" || !Array.isArray(daten.knoten) || !Array.isArray(daten.kanten) || !Array.isArray(daten.abschnitte)) {
    throw new ValidationError("Das Graph-Artefakt hat ein unbekanntes Format.");
  }
  return daten as GraphDaten;
}

/** Elemente, die ein Dokument in den Graphen bringt — die "Einheiten" der Uebersicht. */
export function graphElemente(daten: Pick<GraphDaten, "knoten" | "kanten">): number {
  return daten.knoten.length + daten.kanten.length;
}
