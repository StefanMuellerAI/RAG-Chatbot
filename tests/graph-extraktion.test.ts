import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  EXTRAKTION_PRESET,
  abschnitteArtefaktPfad,
  abschnitteFuerExtraktion,
  baueExtraktionsPrompt,
  fuegeGraphteileZusammen,
  graphArtefaktPfad,
  graphElemente,
  jsonAusAntwort,
  knotenSchluessel,
  leseExtraktion,
  leseGraphDaten,
  normalisiereName,
  verschmelze,
  type Teilergebnis,
} from "@/lib/graph-extraktion";
import {
  STANDARD_BEZIEHUNGEN,
  STANDARD_LABELS,
  STANDARD_ONTOLOGIE,
  effektiveOntologie,
  istGraphDokument,
  istStandardOntologie,
  pruefeOntologie,
  type Ontologie,
} from "@/lib/graph-ontologie";

/**
 * Die Extraktion liefert JSON, nie Cypher. Geprueft wird hier, dass aus einer
 * Modellantwort nur ankommt, was die Ontologie erlaubt, dass Kanten nur
 * zwischen bekannten Knoten entstehen, und dass das Zusammenfuehren dieselbe
 * Entitaet ueber Abschnitte hinweg zu einem Knoten macht — der Import baut
 * darauf, dass ein Schluessel genau einen Knoten meint.
 */

const abschnitt = { nummer: 3, text: "Max Mustermann leitet das Ordnungsamt der Stadt Musterstadt.", location: "S. 2" };

describe("Ontologie", () => {
  it("nimmt Listen als Text oder Array, entfernt Doppelte und behaelt die Reihenfolge", () => {
    const ontologie = pruefeOntologie({ labels: "Person\nVertrag, Person\n Klausel ", beziehungen: ["ENTHAELT", "ENTHAELT", "GILT_AB"], frei: "true" });
    expect(ontologie).toEqual({ labels: ["Person", "Vertrag", "Klausel"], beziehungen: ["ENTHAELT", "GILT_AB"], frei: true });
  });

  it("weist ungueltige und reservierte Bezeichner ab", () => {
    expect(() => pruefeOntologie({ labels: "person" })).toThrow(ValidationError);
    expect(() => pruefeOntologie({ labels: "Straße" })).toThrow(/ohne Umlaute/);
    expect(() => pruefeOntologie({ labels: "Person) DROP" })).toThrow(ValidationError);
    expect(() => pruefeOntologie({ labels: "Quelle" })).toThrow(/reserviert/);
    expect(() => pruefeOntologie({ labels: "Person", beziehungen: "arbeitet fuer" })).toThrow(/Beziehungstyp/);
    expect(() => pruefeOntologie({ labels: "Person", beziehungen: "ERWAEHNT_IN" })).toThrow(/reserviert/);
    expect(() => pruefeOntologie({ labels: "" })).toThrow(/Mindestens eine Knotenart/);
    expect(() => pruefeOntologie("Person")).toThrow(ValidationError);
    expect(() => pruefeOntologie({ labels: Array.from({ length: 41 }, (_, i) => `L${i}`) })).toThrow(/Hoechstens/);
  });

  it("erkennt die Vorgabe, damit nichts gespeichert wird, und liefert sie ohne Abweichung", () => {
    expect(istStandardOntologie(pruefeOntologie({ labels: STANDARD_LABELS.join(","), beziehungen: STANDARD_BEZIEHUNGEN.join("\n") }))).toBe(true);
    expect(istStandardOntologie(pruefeOntologie({ labels: STANDARD_LABELS.join(","), beziehungen: STANDARD_BEZIEHUNGEN.join("\n"), frei: true }))).toBe(false);
    expect(effektiveOntologie({ processing: null })).toBe(STANDARD_ONTOLOGIE);
    expect(effektiveOntologie({ processing: { topK: 5 } })).toBe(STANDARD_ONTOLOGIE);
    const eigene: Ontologie = { labels: ["Bauteil"], beziehungen: [], frei: true };
    expect(effektiveOntologie({ processing: { ontologie: eigene } })).toBe(eigene);
  });

  it("erkennt Dokumente an der Endung", () => {
    expect(istGraphDokument("Bericht.PDF")).toBe(true);
    expect(istGraphDokument("tabelle.xlsx")).toBe(true);
    expect(istGraphDokument("graph.cypher")).toBe(false);
    expect(istGraphDokument("audio.mp3")).toBe(false);
  });
});

describe("Prompt und Abschnitte", () => {
  it("nennt die Ontologie und den Abschnitt samt Fundstelle", () => {
    const { instructions, prompt } = baueExtraktionsPrompt(STANDARD_ONTOLOGIE, abschnitt, { filename: "bericht.pdf" });
    expect(instructions).toContain("Person, Organisation");
    expect(instructions).toContain("ARBEITET_FUER");
    expect(instructions).toContain("nicht erlaubt");
    expect(prompt).toContain("Datei: bericht.pdf");
    expect(prompt).toContain("Fundstelle: S. 2");
    expect(prompt).toContain("Abschnitt 3:");
    expect(prompt).toContain(abschnitt.text);
    expect(baueExtraktionsPrompt({ ...STANDARD_ONTOLOGIE, frei: true }, abschnitt, { filename: "x.pdf" }).instructions).toContain("weitere Knotenart");
  });

  it("zerlegt ohne Ueberlappung in grosse Abschnitte und legt Artefakte neben die Datei", () => {
    expect(EXTRAKTION_PRESET.ueberlappung).toBe(0);
    const text = Array.from({ length: 80 }, (_, i) => `Satz Nummer ${i} handelt von einer Sache, die hier steht.`).join(" ");
    const abschnitte = abschnitteFuerExtraktion([{ text, location: "S. 1" }]);
    expect(abschnitte.length).toBeGreaterThan(1);
    expect(abschnitte.every((a) => a.location === "S. 1")).toBe(true);
    expect(graphArtefaktPfad("files/u/c/d/bericht.pdf")).toBe("files/u/c/d/_graph.json");
    expect(abschnitteArtefaktPfad("files/u/c/d/bericht.pdf")).toBe("files/u/c/d/_abschnitte.json");
  });
});

describe("Antwort lesen", () => {
  const antwort = JSON.stringify({
    knoten: [
      { label: "Person", name: "Max Mustermann", beschreibung: "Leiter des Ordnungsamts" },
      { label: "Organisation", name: "Ordnungsamt" },
      { label: "Organisation", name: "Stadt Musterstadt " },
      { label: "person", name: "MAX MUSTERMANN", beschreibung: "Leiter des Ordnungsamts der Stadt Musterstadt" },
      { label: "Fahrzeug", name: "Dienstwagen" },
      { label: "Person", name: "  " },
    ],
    kanten: [
      { von: "Max Mustermann", typ: "ARBEITET_FUER", nach: "Ordnungsamt" },
      { von: "max mustermann", typ: "arbeitet fuer", nach: "Ordnungsamt" },
      { von: "Ordnungsamt", typ: "GEHOERT_ZU", nach: "Stadt Musterstadt" },
      { von: "Ordnungsamt", typ: "FAEHRT", nach: "Dienstwagen" },
      { von: "Max Mustermann", typ: "KENNT", nach: "Unbekannt" },
      { von: "Ordnungsamt", typ: "GEHOERT_ZU", nach: "Ordnungsamt" },
    ],
  });

  it("holt das JSON auch aus einem Codeblock und lehnt Text ohne Objekt ab", () => {
    expect(jsonAusAntwort("Hier:\n```json\n{\"knoten\":[]}\n```")).toEqual({ knoten: [] });
    expect(() => jsonAusAntwort("Es gibt keine Entitaeten.")).toThrow(ValidationError);
    expect(() => jsonAusAntwort("{\"knoten\": [")).toThrow(ValidationError);
    expect(() => leseExtraktion("{\"knoten\": \"x\"}", STANDARD_ONTOLOGIE, abschnitt)).toThrow(/Format/);
  });

  it("behaelt nur Knoten der Ontologie, fuehrt Schreibweisen zusammen und loest Kanten ueber Namen auf", () => {
    const teil = leseExtraktion(antwort, STANDARD_ONTOLOGIE, abschnitt);
    expect(teil.knoten.map((k) => [k.schluessel, k.name, k.beschreibung])).toEqual([
      ["Person:max mustermann", "Max Mustermann", "Leiter des Ordnungsamts der Stadt Musterstadt"],
      ["Organisation:ordnungsamt", "Ordnungsamt", undefined],
      ["Organisation:stadt musterstadt", "Stadt Musterstadt", undefined],
    ]);
    expect(teil.knoten.every((k) => k.abschnitte.length === 1 && k.abschnitte[0] === 3)).toBe(true);
    expect(teil.kanten.map((k) => `${k.von} -${k.typ}-> ${k.nach}`)).toEqual([
      "Person:max mustermann -ARBEITET_FUER-> Organisation:ordnungsamt",
      "Organisation:ordnungsamt -GEHOERT_ZU-> Organisation:stadt musterstadt",
    ]);
    expect(teil.kanten[0]).toMatchObject({ vonLabel: "Person", nachLabel: "Organisation", abschnitte: [3] });
    // Fahrzeug, leerer Name, FAEHRT, KENNT (Ziel unbekannt), Schleife
    expect(teil.verworfen).toBe(5);
    expect(teil.abschnitte).toEqual([{ nummer: 3, fundstelle: "S. 2", auszug: abschnitt.text }]);
    expect(teil.fehlgeschlagen).toEqual([]);
  });

  it("laesst mit freier Ontologie neue Typen zu, aber keine reservierten oder unlesbaren", () => {
    const frei: Ontologie = { labels: ["Person"], beziehungen: [], frei: true };
    const teil = leseExtraktion(JSON.stringify({
      knoten: [
        { label: "Person", name: "Anna" }, { label: "fahrzeug", name: "Dienstwagen" },
        { label: "Quelle", name: "x" }, { label: "Bau-Teil", name: "Schraube" },
      ],
      kanten: [
        { von: "Anna", typ: "faehrt mit", nach: "Dienstwagen" },
        { von: "Anna", typ: "ERWAEHNT_IN", nach: "Dienstwagen" },
        { von: "Anna", typ: "HAT", nach: "Schraube" },
      ],
    }), frei, abschnitt);
    expect(teil.knoten.map((k) => k.schluessel)).toEqual(["Person:anna", "Fahrzeug:dienstwagen", "BauTeil:schraube"]);
    expect(teil.kanten.map((k) => k.typ)).toEqual(["FAEHRT_MIT", "HAT"]);
    expect(teil.verworfen).toBe(2);
  });

  it("normalisiert Namen fuer den Schluessel, nicht fuer die Anzeige", () => {
    expect(normalisiereName("  „Stadt  Musterstadt“. ")).toBe("stadt musterstadt");
    expect(knotenSchluessel("Ort", "Köln")).toBe("Ort:köln");
  });
});

describe("Zusammenfuehren", () => {
  const teil = (nummer: number, name: string, beschreibung?: string): Teilergebnis => ({
    knoten: [
      { schluessel: `Person:${name.toLowerCase()}`, label: "Person", name, ...(beschreibung ? { beschreibung } : {}), abschnitte: [nummer] },
      { schluessel: "Organisation:amt", label: "Organisation", name: "Amt", abschnitte: [nummer] },
    ],
    kanten: [{ von: `Person:${name.toLowerCase()}`, vonLabel: "Person", typ: "ARBEITET_FUER", nach: "Organisation:amt", nachLabel: "Organisation", abschnitte: [nummer] }],
    abschnitte: [{ nummer, fundstelle: null, auszug: `Abschnitt ${nummer}` }],
    fehlgeschlagen: [],
    verworfen: 0,
  });

  it("macht aus gleichen Schluesseln einen Knoten mit allen Fundstellen und der laengsten Beschreibung", () => {
    const gesamt = verschmelze([teil(2, "Anna", "kurz"), teil(1, "Anna", "eine laengere Beschreibung"), teil(3, "Bernd")]);
    const anna = gesamt.knoten.find((k) => k.schluessel === "Person:anna")!;
    expect(anna.abschnitte).toEqual([2, 1]);
    expect(anna.beschreibung).toBe("eine laengere Beschreibung");
    expect(gesamt.knoten.find((k) => k.schluessel === "Organisation:amt")!.abschnitte).toEqual([2, 1, 3]);
    expect(gesamt.kanten).toHaveLength(2);
    expect(gesamt.kanten[0].abschnitte).toEqual([2, 1]);
    expect(gesamt.abschnitte.map((a) => a.nummer)).toEqual([1, 2, 3]);
  });

  it("liefert das Artefakt mit Version und Herkunft und liest nur diese Fassung", () => {
    const daten = fuegeGraphteileZusammen([teil(1, "Anna")], { docId: "doc-1", filename: "bericht.pdf" });
    expect(daten).toMatchObject({ version: 1, docId: "doc-1", filename: "bericht.pdf" });
    expect(graphElemente(daten)).toBe(3);
    expect(leseGraphDaten(JSON.stringify(daten))).toEqual(daten);
    expect(() => leseGraphDaten(JSON.stringify({ ...daten, version: 2 }))).toThrow(ValidationError);
    expect(() => leseGraphDaten("{}")).toThrow(ValidationError);
  });
});
