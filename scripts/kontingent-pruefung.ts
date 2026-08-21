import type { Kontext } from "../lib/auth/user";
import { QuotaError, ValidationError } from "../lib/errors";
import {
  pruefeGroessenklasse,
  pruefeNeuesDokument,
  pruefeSammlungsText,
  pruefeSeitenzahl,
} from "../lib/quota";

/**
 * Pruefung der Kontingentgrenzen.
 *
 *   npm run pruefe:kontingente
 *
 * Diese Regeln entscheiden, was ein Nutzer anlegen darf. Ein Fehler darin faellt
 * im Betrieb entweder nie auf (weil zu lasch) oder erst beim Nutzer (weil zu
 * streng) - beides schlechte Zeitpunkte. Die Faelle unten pruefen ausdruecklich
 * auch die Grenzen selbst: genau am Limit muss es noch gehen, einen Schritt
 * darueber nicht mehr.
 */

const MB = 1024 * 1024;

let fehler = 0;

function pruefe(bezeichnung: string, bedingung: boolean, zusatz = ""): void {
  if (bedingung) {
    console.log(`  OK      ${bezeichnung}`);
  } else {
    console.error(`  FEHLER  ${bezeichnung}${zusatz ? ` — ${zusatz}` : ""}`);
    fehler += 1;
  }
}

/** true, wenn der Aufruf mit der erwarteten Fehlerart abgelehnt wird. */
function lehntAb(aufruf: () => void, art: "kontingent" | "eingabe"): boolean {
  try {
    aufruf();
    return false;
  } catch (error) {
    return art === "kontingent"
      ? error instanceof QuotaError
      : error instanceof ValidationError;
  }
}

function laesstZu(aufruf: () => void): boolean {
  try {
    aufruf();
    return true;
  } catch {
    return false;
  }
}

// --- Testdaten --------------------------------------------------------------

function klasse(id: string, rank: number, werte: Partial<Record<string, number>> = {}) {
  return {
    id,
    label: id,
    rank,
    maxDocuments: werte.maxDocuments ?? 20,
    maxPagesPerDocument: werte.maxPagesPerDocument ?? 100,
    maxTotalPages: werte.maxTotalPages ?? 2_000,
    maxFileBytes: werte.maxFileBytes ?? 25 * MB,
  };
}

const S = klasse("S", 1);
const L = klasse("L", 3, { maxDocuments: 500, maxPagesPerDocument: 1_000 });

function kontextMit(klassenRang: number, planLabel = "S"): Kontext {
  return {
    userId: "user_test",
    isAdmin: false,
    plan: {
      id: planLabel,
      label: planLabel,
      maxSizeClassId: planLabel,
      maxCollections: 3,
      maxQuestionsPerDay: 200,
      modelId: "google/gemini-2.5-flash-lite",
      isDefault: true,
    },
    maxSizeClass: klasse(planLabel, klassenRang),
  };
}

function sammlung(werte: { documentCount?: number; pageCount?: number } = {}) {
  return {
    name: "Testsammlung",
    documentCount: werte.documentCount ?? 0,
    pageCount: werte.pageCount ?? 0,
  };
}

// --- Groessenklasse gegen Plan ----------------------------------------------

console.log("\nGroessenklasse gegen Plan");

pruefe(
  "Plan S darf eine S-Sammlung anlegen",
  laesstZu(() => pruefeGroessenklasse(kontextMit(1), S)),
);
pruefe(
  "Plan S darf KEINE L-Sammlung anlegen",
  lehntAb(() => pruefeGroessenklasse(kontextMit(1), L), "kontingent"),
);
pruefe(
  "Plan L darf eine S-Sammlung anlegen (kleinere Klassen bleiben erlaubt)",
  laesstZu(() => pruefeGroessenklasse(kontextMit(3, "L"), S)),
);
pruefe(
  "Plan L darf eine L-Sammlung anlegen (genau am Rang)",
  laesstZu(() => pruefeGroessenklasse(kontextMit(3, "L"), L)),
);

// --- Neues Dokument ---------------------------------------------------------

console.log("\nNeues Dokument");

pruefe(
  "19 von 20 Dokumenten: geht",
  laesstZu(() => pruefeNeuesDokument(sammlung({ documentCount: 19 }), S, 1 * MB)),
);
pruefe(
  "20 von 20 Dokumenten: voll",
  lehntAb(() => pruefeNeuesDokument(sammlung({ documentCount: 20 }), S, 1 * MB), "kontingent"),
);
pruefe(
  "Datei genau auf der Grenze: geht",
  laesstZu(() => pruefeNeuesDokument(sammlung(), S, 25 * MB)),
);
pruefe(
  "Datei ein Byte darueber: abgelehnt",
  lehntAb(() => pruefeNeuesDokument(sammlung(), S, 25 * MB + 1), "kontingent"),
);

// --- Seitenzahl -------------------------------------------------------------

console.log("\nSeitenzahl (erst nach der Extraktion pruefbar)");

pruefe(
  "100 Seiten in S: genau die Grenze, geht",
  laesstZu(() => pruefeSeitenzahl(sammlung(), S, 100)),
);
pruefe(
  "101 Seiten in S: abgelehnt",
  lehntAb(() => pruefeSeitenzahl(sammlung(), S, 101), "kontingent"),
);
pruefe(
  "Gesamtgrenze greift, auch wenn das Dokument selbst passt",
  // 1.950 vorhanden, 100 neu: das Dokument ist erlaubt, die Summe nicht.
  lehntAb(() => pruefeSeitenzahl(sammlung({ pageCount: 1_950 }), S, 100), "kontingent"),
);
pruefe(
  "Summe genau auf der Gesamtgrenze: geht",
  laesstZu(() => pruefeSeitenzahl(sammlung({ pageCount: 1_900 }), S, 100)),
);

// --- Meldungen --------------------------------------------------------------

console.log("\nMeldungen");

function meldungVon(aufruf: () => void): string {
  try {
    aufruf();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const vollMeldung = meldungVon(() =>
  pruefeNeuesDokument(sammlung({ documentCount: 20 }), S, 1 * MB),
);
pruefe(
  "die Meldung nennt Grenze und Groessenklasse",
  vollMeldung.includes("20") && vollMeldung.includes("S"),
  vollMeldung,
);

const groesseMeldung = meldungVon(() => pruefeNeuesDokument(sammlung(), S, 40 * MB));
pruefe(
  "die Meldung nennt die tatsaechliche und die erlaubte Groesse",
  groesseMeldung.includes("40.0 MB") && groesseMeldung.includes("25.0 MB"),
  groesseMeldung,
);

// --- Name und Beschreibung --------------------------------------------------

console.log("\nName und Beschreibung");

pruefe(
  "Leerraum wird zusammengefasst und getrimmt",
  pruefeSammlungsText("  Gebuehren   2026  ", " Preise ").name === "Gebuehren 2026",
);
pruefe(
  "einzelnes Zeichen als Name: abgelehnt",
  lehntAb(() => pruefeSammlungsText("A", ""), "eingabe"),
);
pruefe(
  "leerer Name: abgelehnt",
  lehntAb(() => pruefeSammlungsText("   ", ""), "eingabe"),
);
pruefe(
  "Name mit 80 Zeichen: geht",
  laesstZu(() => pruefeSammlungsText("A".repeat(80), "")),
);
pruefe(
  "Name mit 81 Zeichen: abgelehnt",
  lehntAb(() => pruefeSammlungsText("A".repeat(81), ""), "eingabe"),
);
pruefe(
  "Beschreibung mit 400 Zeichen: geht",
  laesstZu(() => pruefeSammlungsText("Sammlung", "B".repeat(400))),
);
pruefe(
  // Die Beschreibung steht im Katalog, den das Modell bei jeder Frage sieht.
  // Ohne Obergrenze summieren sich viele Sammlungen zu einem erheblichen Teil
  // jedes Prompts.
  "Beschreibung mit 401 Zeichen: abgelehnt",
  lehntAb(() => pruefeSammlungsText("Sammlung", "B".repeat(401)), "eingabe"),
);
pruefe(
  "fehlende Beschreibung ist erlaubt",
  pruefeSammlungsText("Sammlung", undefined).beschreibung === "",
);

// --- Ergebnis ---------------------------------------------------------------

if (fehler > 0) {
  console.error(`\n${fehler} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}

console.log("\nAlle Pruefungen bestanden.");
