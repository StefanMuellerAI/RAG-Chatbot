import { chunkBlocks } from "../lib/chunk";
import type { ExtractedBlock } from "../lib/extract";
import { findPreset } from "../lib/presets";

/**
 * Pruefung der drei Zerlegungsstrategien.
 *
 *   npm run pruefe:chunks
 *
 * Kein Testframework, weil es hier genau eine reine Funktion mit drei Zweigen
 * zu pruefen gibt. Die Faelle unten sind nicht willkuerlich: jeder hat einmal
 * einen Fehler aufgedeckt.
 *
 * Der wichtigste ist der letzte. Ein Schnitt an einer Paragraphengrenze mit
 * anschliessender Ueberlappung setzt den naechsten Abschnitt VOR diese Grenze
 * zurueck. Der naechste Durchgang findet dieselbe Grenze wieder, ruckt um ein
 * Zeichen vor, und aus drei Abschnitten werden vierundfuenfzig fast gleiche.
 */

let fehler = 0;

function pruefe(bezeichnung: string, bedingung: boolean, zusatz = ""): void {
  if (bedingung) {
    console.log(`  OK      ${bezeichnung}`);
  } else {
    console.error(`  FEHLER  ${bezeichnung}${zusatz ? ` — ${zusatz}` : ""}`);
    fehler += 1;
  }
}

function zerlege(bloecke: ExtractedBlock[], presetId: string) {
  return chunkBlocks(bloecke, findPreset(presetId));
}

// --- Tabellen ---------------------------------------------------------------

console.log("\nTabellen und Zahlen");

const KOPF = "Leistung | Gebuehr | Raum | Ansprechpartner";
const tabelle = zerlege(
  [
    {
      text: Array.from(
        { length: 40 },
        (_, i) => `Leistung ${i + 1} | ${(i + 1) * 3},50 EUR | Zimmer ${100 + i} | Frau Muster`,
      ).join("\n"),
      location: 'Tabellenblatt "Gebuehren"',
      kopfzeile: KOPF,
    },
  ],
  "tabellen",
);

pruefe("wird ueberhaupt zerlegt", tabelle.length > 1, `${tabelle.length} Abschnitte`);
pruefe(
  "Kopfzeile steht in jedem Abschnitt",
  tabelle.every((abschnitt) => abschnitt.text.startsWith(KOPF)),
);
pruefe(
  "keine Datenzeile ist mitten getrennt",
  tabelle.every((abschnitt) =>
    abschnitt.text
      .split("\n")
      .slice(1)
      .every((zeile) => /^Leistung \d+ \| \d+,50 EUR \| Zimmer \d+ \| Frau Muster$/.test(zeile)),
  ),
);
pruefe(
  "jede Datenzeile kommt genau einmal vor",
  new Set(
    tabelle.flatMap((abschnitt) => abschnitt.text.split("\n").slice(1)),
  ).size === 40,
);

const kurzesBlatt = zerlege(
  [
    {
      text: "Montag | 8-12\nDienstag | 8-16",
      location: 'Tabellenblatt "Zeiten"',
      kopfzeile: "Tag | Zeit",
    },
  ],
  "tabellen",
);
pruefe(
  "kurzes Tabellenblatt wird nicht verworfen",
  kurzesBlatt.length === 1 && kurzesBlatt[0].text.includes("Dienstag"),
);

// --- Regelwerke -------------------------------------------------------------

console.log("\nRegelwerke");

const satzung = [
  "§ 1 Geltungsbereich",
  `Diese Satzung gilt fuer alle Dienstleistungen des Buergeramts. ${"Sie regelt Art und Hoehe der Gebuehren. ".repeat(8)}`,
  "",
  "§ 2 Gebuehrenschuldner",
  `Gebuehrenschuldner ist, wer die Leistung veranlasst. ${"Mehrere Schuldner haften als Gesamtschuldner. ".repeat(8)}`,
  "",
  "§ 3 Faelligkeit",
  `Die Gebuehr wird mit Bekanntgabe des Bescheids faellig. ${"Ratenzahlung ist auf Antrag moeglich. ".repeat(8)}`,
].join("\n");

const regelwerk = zerlege([{ text: satzung, location: "Seite 1" }], "regelwerke");

pruefe(
  "jeder Abschnitt beginnt mit seiner Bestimmung",
  regelwerk.every((abschnitt) => /^§ \d/.test(abschnitt.text)),
);
pruefe(
  "die Ueberschrift passt zum Inhalt des Abschnitts",
  // Der Kern des behobenen Fehlers: ein Abschnitt ueber die Faelligkeit darf
  // nicht mit "§ 1 Geltungsbereich" ueberschrieben sein.
  regelwerk.every((abschnitt) => {
    if (abschnitt.text.includes("Bekanntgabe des Bescheids")) {
      return abschnitt.text.startsWith("§ 3");
    }
    if (abschnitt.text.includes("Gesamtschuldner")) {
      return abschnitt.text.startsWith("§ 2");
    }
    return true;
  }),
);
pruefe(
  "keine Abschnittsflut durch Kriechen der Schnittkante",
  regelwerk.length <= 6,
  `${regelwerk.length} Abschnitte fuer drei Paragraphen`,
);
pruefe(
  "alle drei Paragraphen sind vertreten",
  ["§ 1", "§ 2", "§ 3"].every((marke) =>
    regelwerk.some((abschnitt) => abschnitt.text.startsWith(marke)),
  ),
);

// --- Fliesstext -------------------------------------------------------------

console.log("\nFliesstext");

const bericht = (
  "Die Verwaltung hat im Berichtsjahr zahlreiche Vorgaenge bearbeitet. " +
  "Der Schwerpunkt lag auf der Digitalisierung der Antragsverfahren. "
).repeat(30);

const fliesstext = zerlege([{ text: bericht, location: "Seite 7" }], "fliesstext");
const laengen = fliesstext.map((abschnitt) => abschnitt.text.length);

pruefe("wird zerlegt", fliesstext.length > 1, `${fliesstext.length} Abschnitte`);
pruefe(
  "kein Abschnitt ueberschreitet die Zielgroesse deutlich",
  Math.max(...laengen) <= 1_300,
  `laengster: ${Math.max(...laengen)}`,
);
pruefe(
  "Fundstelle bleibt an jedem Abschnitt",
  fliesstext.every((abschnitt) => abschnitt.location === "Seite 7"),
);

// --- Randfaelle -------------------------------------------------------------

console.log("\nRandfaelle");

const start = Date.now();
const ohneKanten = zerlege([{ text: "A".repeat(20_000) }], "fliesstext");
const dauer = Date.now() - start;

pruefe(
  "Text ohne jede Schnittkante terminiert zuegig",
  ohneKanten.length > 0 && dauer < 1_000,
  `${ohneKanten.length} Abschnitte in ${dauer} ms`,
);
pruefe("leerer Text ergibt keinen Abschnitt", zerlege([{ text: "" }], "fliesstext").length === 0);
pruefe(
  "reine Seitenzahl wird verworfen",
  zerlege([{ text: "7" }], "fliesstext").length === 0,
);
pruefe(
  "kurzer, aber vollstaendiger Text bleibt erhalten",
  zerlege([{ text: "Oeffnungszeiten: Mo-Fr 8 bis 16 Uhr." }], "fliesstext").length === 1,
);

// --- Ergebnis ---------------------------------------------------------------

if (fehler > 0) {
  console.error(`\n${fehler} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}

console.log("\nAlle Pruefungen bestanden.");
