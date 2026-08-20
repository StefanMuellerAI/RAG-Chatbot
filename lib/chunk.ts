import type { ExtractedBlock } from "./extract";
import type { Preset } from "./presets";
import type { UpsertChunk } from "./vector";

/**
 * Zerlegt die extrahierten Bloecke in durchsuchbare Abschnitte — nach der
 * Strategie des gewaehlten Presets.
 *
 * Warum nicht ein Verfahren fuer alles: Ein Abschnitt ist die kleinste Einheit,
 * die spaeter als Treffer zurueckkommt und einzeln zitiert wird. Er muss also
 * fuer sich verstaendlich sein. Was das bedeutet, haengt vom Material ab:
 *
 *   Fliesstext  — verstaendlich ist, was einen Gedanken zu Ende bringt. Grosse
 *                 Abschnitte, Schnitt an Absatz- oder Satzgrenzen, Ueberlappung
 *                 gegen Aussagen, die genau auf einer Kante liegen.
 *   Tabellen    — verstaendlich ist eine Zeile nur mit ihren Spaltenkoepfen.
 *                 Die Kopfzeile wird deshalb in JEDEN Abschnitt wiederholt.
 *                 Ueberlappung entfaellt: eine doppelt gefuehrte Tabellenzeile
 *                 ist kein gewonnener Zusammenhang, sondern ein zweiter Treffer
 *                 mit gleichem Inhalt.
 *   Regelwerke  — verstaendlich ist eine Bestimmung mit ihrer Ueberschrift.
 *                 Kleine Abschnitte, Schnitt an Paragraphen- und
 *                 Gliederungsmarken, die zugehoerige Ueberschrift bleibt dabei.
 */

/**
 * Untergrenze fuer einen Abschnitt. Sie soll nur echte Artefakte abfangen —
 * eine allein stehende Seitenzahl etwa. Sie darf NICHT dazu fuehren, dass ein
 * kurzer, aber inhaltlich vollstaendiger Block verworfen wird: ein knappes
 * Tabellenblatt mit den Oeffnungszeiten ist genau die Art Information, nach der
 * spaeter gefragt wird.
 */
const MIN_SIZE = 15;

export function chunkBlocks(bloecke: ExtractedBlock[], preset: Preset): UpsertChunk[] {
  const abschnitte: UpsertChunk[] = [];

  for (const block of bloecke) {
    const teile =
      preset.strategie === "tabelle"
        ? teileTabelle(block, preset)
        : teileText(block.text, preset);

    for (const text of teile) {
      abschnitte.push(block.location ? { text, location: block.location } : { text });
    }
  }

  return abschnitte;
}

// --- Tabellen ---------------------------------------------------------------

/**
 * Zerlegt ein Tabellenblatt in Zeilenbloecke und stellt jedem die Kopfzeile
 * voran.
 *
 * Geschnitten wird ausschliesslich an Zeilenenden. Eine mitten in einer Zeile
 * getrennte Tabelle ergibt zwei Abschnitte, von denen keiner die Zeile
 * enthaelt — der eine hat die halben Werte ohne Bezug, der andere den Rest.
 */
function teileTabelle(block: ExtractedBlock, preset: Preset): string[] {
  const zeilen = block.text.split("\n").filter((zeile) => zeile.trim().length > 0);
  if (zeilen.length === 0) return [];

  const kopf = block.kopfzeile?.trim();
  const kopfLaenge = kopf ? kopf.length + 1 : 0;
  const abschnitte: string[] = [];

  let aktuell: string[] = [];
  let laenge = 0;

  const abschliessen = () => {
    if (aktuell.length === 0) return;
    const inhalt = aktuell.join("\n");
    const text = kopf ? `${kopf}\n${inhalt}` : inhalt;
    if (istVerwertbar(text)) abschnitte.push(text);
    aktuell = [];
    laenge = 0;
  };

  for (const zeile of zeilen) {
    // Eine einzelne Zeile, die allein schon zu lang ist, bekommt ihren eigenen
    // Abschnitt statt abgeschnitten zu werden.
    if (laenge > 0 && kopfLaenge + laenge + zeile.length > preset.zielGroesse) {
      abschliessen();
    }

    aktuell.push(zeile);
    laenge += zeile.length + 1;
  }

  abschliessen();
  return abschnitte;
}

// --- Fliesstext und Regelwerke ----------------------------------------------

function teileText(text: string, preset: Preset): string[] {
  if (!text) return [];

  if (text.length <= preset.zielGroesse) {
    return istVerwertbar(text) ? [text] : [];
  }

  const gliederung = preset.strategie === "gliederung";

  // Alle Gliederungsueberschriften vorab mit ihrer Position erfassen.
  //
  // Der naheliegende Weg — beim Durchlaufen die zuletzt gesehene Ueberschrift
  // mitfuehren — ist falsch, und zwar folgenreich: Beginnt ein Abschnitt wegen
  // der Ueberlappung mitten in einem Satz, erkennt man an seiner ersten Zeile
  // keine Ueberschrift und behaelt die alte. Ein Abschnitt ueber "§ 3
  // Faelligkeit" wuerde dann mit "§ 1 Geltungsbereich" ueberschrieben, und das
  // Modell zitierte die falsche Bestimmung. Mit den Positionen laesst sich
  // stattdessen bestimmen, welche Ueberschrift am ANFANG des Abschnitts gilt.
  const ueberschriften = gliederung ? findeUeberschriften(text) : [];

  const abschnitte: string[] = [];
  let start = 0;

  while (start < text.length) {
    const hartesEnde = Math.min(start + preset.zielGroesse, text.length);
    const schnitt =
      hartesEnde === text.length
        ? { ende: hartesEnde, strukturell: true }
        : findeSchnitt(text, start, hartesEnde, preset);

    const roh = text.slice(start, schnitt.ende).trim();

    if (roh) {
      const gueltige = gliederung ? ueberschriftBei(ueberschriften, start) : "";

      // Nur voranstellen, wenn der Abschnitt sie nicht schon selbst traegt —
      // sonst stuende sie doppelt.
      const fertig =
        gueltige && !roh.startsWith(gueltige) ? `${gueltige}\n${roh}` : roh;

      if (istVerwertbar(fertig)) abschnitte.push(fertig);
    }

    if (schnitt.ende >= text.length) break;

    /**
     * Ueberlappung nur bei einem willkuerlichen Schnitt.
     *
     * Sie soll Aussagen retten, die genau auf einer beliebig gesetzten Kante
     * liegen. Ein Schnitt an einer Gliederungsgrenze ist aber nicht beliebig —
     * dort soll der naechste Abschnitt gerade beginnen. Ihn davor anzusetzen
     * kostet nicht nur Token, es laesst die Schleife auch kriechen: Der naechste
     * Durchgang findet dieselbe Grenze wieder, ruckt um ein Zeichen vor und
     * erzeugt so hunderte fast gleicher Abschnitte.
     */
    const naechster = schnitt.strukturell
      ? schnitt.ende
      : schnitt.ende - preset.ueberlappung;

    // Echten Fortschritt in jedem Fall erzwingen.
    start = Math.max(naechster, start + 1);
  }

  return abschnitte;
}

/**
 * Erkennt die Formen, die in deutschen Regelwerken tatsaechlich vorkommen:
 * "§ 12 Gebuehren", "Artikel 3", "(4) ...", "2.1 Zustaendigkeit".
 */
const UEBERSCHRIFT =
  /^(?:§+\s*\d+|Art(?:ikel)?\.?\s*\d+|Abs(?:atz)?\.?\s*\d+|\(\d+\)|\d+(?:\.\d+)*\.?)\s/;

type Ueberschrift = { position: number; titel: string };

/** Alle Gliederungsueberschriften mit ihrer Position im Text. */
function findeUeberschriften(text: string): Ueberschrift[] {
  const gefunden: Ueberschrift[] = [];
  let position = 0;

  for (const zeile of text.split("\n")) {
    const sauber = zeile.trim();
    // Eine ueberlange Zeile ist ein Absatz, der zufaellig mit einer Zahl
    // beginnt, und keine Ueberschrift.
    if (sauber && sauber.length <= 120 && UEBERSCHRIFT.test(sauber)) {
      gefunden.push({ position, titel: sauber });
    }
    position += zeile.length + 1;
  }

  return gefunden;
}

/** Die Ueberschrift, die an dieser Position gilt: die letzte davor. */
function ueberschriftBei(ueberschriften: Ueberschrift[], position: number): string {
  let gueltig = "";
  for (const eintrag of ueberschriften) {
    if (eintrag.position > position) break;
    gueltig = eintrag.titel;
  }
  return gueltig;
}

/**
 * Sucht rueckwaerts ab `hartesEnde` die beste Schnittkante.
 *
 * `strukturell` sagt, ob die Kante aus dem Aufbau des Dokuments stammt (Beginn
 * einer neuen Bestimmung) oder nur die am wenigsten stoerende Stelle innerhalb
 * eines Textflusses ist. Davon haengt ab, ob der naechste Abschnitt
 * ueberlappend ansetzt.
 */
function findeSchnitt(
  text: string,
  start: number,
  hartesEnde: number,
  preset: Preset,
): { ende: number; strukturell: boolean } {
  // Nicht weiter als bis zur Haelfte zurueckgehen: eine schoene Kante, die den
  // Abschnitt auf ein Viertel schrumpfen laesst, ist keine gute Kante.
  const frueheste = start + Math.floor(preset.zielGroesse / 2);

  if (preset.strategie === "gliederung") {
    // Eine neue Bestimmung ist die natuerliche Grenze — dort zu schneiden haelt
    // Paragraphen zusammen, statt sie ueber zwei Abschnitte zu verteilen.
    //
    // Das Fenster reicht hier weiter zurueck als bei den anderen Strategien:
    // Bei Regelwerken ist ein sauber abgegrenzter Paragraph mehr wert als ein
    // gleichmaessig gefuellter Abschnitt.
    const frueheGrenze = start + Math.floor(preset.zielGroesse / 4);
    const marke = letzteGliederungsmarke(text, frueheGrenze, hartesEnde);
    if (marke > frueheGrenze) return { ende: marke, strukturell: true };
  }

  const absatz = text.lastIndexOf("\n\n", hartesEnde);
  if (absatz > frueheste) return { ende: absatz, strukturell: false };

  for (const marke of [". ", ".\n", "! ", "? ", "; "]) {
    const stelle = text.lastIndexOf(marke, hartesEnde);
    if (stelle > frueheste) return { ende: stelle + marke.length, strukturell: false };
  }

  const leerzeichen = text.lastIndexOf(" ", hartesEnde);
  return {
    ende: leerzeichen > frueheste ? leerzeichen : hartesEnde,
    strukturell: false,
  };
}

/** Letzter Zeilenanfang im Fenster, der eine Bestimmung eroeffnet. */
function letzteGliederungsmarke(text: string, von: number, bis: number): number {
  const fenster = text.slice(von, bis);
  const muster = /\n(?=(?:§+\s*\d+|Art(?:ikel)?\.?\s*\d+|\(\d+\)|\d+(?:\.\d+)*\.?)\s)/g;

  let letzte = -1;
  let treffer: RegExpExecArray | null;
  while ((treffer = muster.exec(fenster)) !== null) {
    letzte = treffer.index;
  }

  return letzte === -1 ? -1 : von + letzte + 1;
}

/** Enthaelt der Abschnitt genug Substanz, um durchsuchbar zu sein? */
function istVerwertbar(text: string): boolean {
  return text.length >= MIN_SIZE && /[\p{L}\p{N}]/u.test(text);
}
