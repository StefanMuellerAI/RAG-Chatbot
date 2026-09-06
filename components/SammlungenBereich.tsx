"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { erstelleSammlungAktion } from "@/app/sammlungen/actions";
import {
  COLLECTION_KINDS,
  KIND_DESCRIPTION,
  KIND_LABEL,
  type CollectionKind,
} from "@/lib/collection-kinds";
import type { SammlungMitKlasse } from "@/lib/collections";
import type { SizeClass } from "@/lib/db/schema";
import {
  BEZIEHUNG_MUSTER,
  LABEL_MUSTER,
  ONTOLOGIE_MAX_EINTRAEGE,
  PROVENIENZ,
  STANDARD_BEZIEHUNGEN,
  STANDARD_LABELS,
  alsZeilen,
} from "@/lib/graph-ontologie";
import {
  STANDARD_MIN_RERANK,
  STANDARD_MIN_SCORE,
  VERARBEITUNG_GRENZEN,
  maxUeberlappung,
  type Preset,
  type VerarbeitungOverride,
  type VerarbeitungsFeld,
} from "@/lib/presets";

type Eigenschaften = {
  sammlungen: SammlungMitKlasse[];
  klassen: SizeClass[];
  presets: Preset[];
  /** Ohne FALKORDB_URL lassen sich keine Graph-Sammlungen anlegen. */
  graphVerfuegbar: boolean;
  /** Mit GRAPH_EXTRAKTION_MODELL nehmen Graph-Sammlungen Dokumente an und haben eine Ontologie. */
  graphExtraktionVerfuegbar: boolean;
  /** Ohne RERANK_MODEL zeigt der Expertenmodus keine Reranker-Felder. */
  rerankVerfuegbar: boolean;
  plan: { label: string; maxCollections: number; maxSizeClassId: string };
};

type NeueSammlung = {
  name: string;
  beschreibung: string;
  kind: CollectionKind;
  preset: string;
  sizeClassId: string;
  /** Expertenmodus; null, wenn die Werte des Presets gelten sollen. */
  verarbeitung: VerarbeitungOverride | null;
  /** Ontologie einer Graph-Sammlung; null, wenn die Vorgabe gelten soll. */
  ontologie: OntologieEingabe | null;
};

export default function SammlungenBereich({
  sammlungen,
  klassen,
  presets,
  graphVerfuegbar,
  graphExtraktionVerfuegbar,
  rerankVerfuegbar,
  plan,
}: Eigenschaften) {
  const [laueft, starte] = useTransition();
  const [formularOffen, setFormularOffen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const voll = sammlungen.length >= plan.maxCollections;

  // Ein Roundtrip: Die Action legt an und bringt die neu gerenderte Liste
  // gleich mit. `laueft` deckt genau diese eine Fahrt ab.
  function anlegen(eingabe: NeueSammlung) {
    setFehler(null);

    starte(async () => {
      try {
        const ergebnis = await erstelleSammlungAktion(eingabe);
        if (!ergebnis.ok) {
          setFehler(ergebnis.fehler);
          return;
        }
        setFormularOffen(false);
      } catch (error) {
        setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
      }
    });
  }

  return (
    <>
      {fehler && <div className="meldung">{fehler}</div>}

      <div className="karte">
        <h1 className="karte-titel">
          Sammlungen{" "}
          <span className="karte-zusatz">
            · Plan {plan.label} · {sammlungen.length} von {plan.maxCollections} · bis
            Groessenklasse {plan.maxSizeClassId}
          </span>
        </h1>
        <p className="hinweis-text">
          Eine Sammlung ist ein abgegrenzter Bestand an Unterlagen. Trennen Sie, was
          inhaltlich nicht zusammengehoert — im Chat waehlt der Assistent anhand von Name
          und Beschreibung selbst aus, wo er sucht, und das gelingt umso besser, je klarer
          die Sammlungen voneinander abgegrenzt sind.
        </p>

        {!formularOffen && (
          <button
            className="knopf"
            disabled={voll || klassen.length === 0}
            onClick={() => setFormularOffen(true)}
          >
            Neue Sammlung
          </button>
        )}

        {voll && !formularOffen && (
          <p className="hinweis-text" style={{ marginTop: 12, marginBottom: 0 }}>
            Ihr Plan erlaubt {plan.maxCollections}{" "}
            {plan.maxCollections === 1 ? "Sammlung" : "Sammlungen"}. Fuer weitere muesste
            der Plan angehoben werden.
          </p>
        )}

        {formularOffen && (
          <Anlegeformular
            klassen={klassen}
            presets={presets}
            graphVerfuegbar={graphVerfuegbar}
            graphExtraktionVerfuegbar={graphExtraktionVerfuegbar}
            rerankVerfuegbar={rerankVerfuegbar}
            gesperrt={laueft}
            onAbbrechen={() => setFormularOffen(false)}
            onAnlegen={anlegen}
          />
        )}
      </div>

      {sammlungen.length === 0 ? (
        <div className="karte">
          <p className="hinweis-text" style={{ margin: 0 }}>
            Noch keine Sammlung angelegt. Der Chat kann derzeit keine Fragen beantworten.
          </p>
        </div>
      ) : (
        <div className="sammlungen-raster">
          {sammlungen.map((sammlung) => {
            const preset = presets.find((eintrag) => eintrag.id === sammlung.preset);
            // Das Preset steuert nur das Zerlegen von Text; bei Tabellen und
            // Graphen sagt es nichts aus und wird deshalb nicht gezeigt.
            const verarbeitung =
              sammlung.kind === "vector"
                ? (preset?.label ?? sammlung.preset)
                : KIND_LABEL[sammlung.kind];
            return (
              <Link key={sammlung.id} href={`/sammlungen/${sammlung.id}`} className="sammlung-karte">
                <div className="sammlung-kopf">
                  <span className="sammlung-name">
                    {sammlung.name}
                    <span className={`typ-marke typ-${sammlung.kind}`}>
                      {KIND_LABEL[sammlung.kind]}
                    </span>
                  </span>
                  <span className="marke">{sammlung.sizeClass.id}</span>
                </div>

                <p className="sammlung-beschreibung">
                  {sammlung.description || "Keine Beschreibung hinterlegt."}
                </p>

                <div className="sammlung-fuss">
                  {verarbeitung}
                  {sammlung.kind === "vector" && sammlung.processing ? " (angepasst)" : ""} ·{" "}
                  {sammlung.documentCount}{" "}
                  {sammlung.documentCount === 1 ? "Dokument" : "Dokumente"} ·{" "}
                  {sammlung.pageCount} Seiten
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

// --- Anlegeformular ---------------------------------------------------------

function Anlegeformular({
  klassen,
  presets,
  graphVerfuegbar,
  graphExtraktionVerfuegbar,
  rerankVerfuegbar,
  gesperrt,
  onAbbrechen,
  onAnlegen,
}: {
  klassen: SizeClass[];
  presets: Preset[];
  graphVerfuegbar: boolean;
  graphExtraktionVerfuegbar: boolean;
  rerankVerfuegbar: boolean;
  gesperrt: boolean;
  onAbbrechen: () => void;
  onAnlegen: (eingabe: NeueSammlung) => void;
}) {
  const [name, setName] = useState("");
  const [beschreibung, setBeschreibung] = useState("");
  const [kind, setKind] = useState<CollectionKind>("vector");
  const [preset, setPreset] = useState(presets[0]?.id ?? "fliesstext");
  // Die kleinste erlaubte Klasse als Vorauswahl: Sie ist bei allen Plaenen
  // verfuegbar, und heraufsetzen ist einfacher zu verstehen als herabsetzen.
  const [sizeClassId, setSizeClassId] = useState(klassen[0]?.id ?? "");
  // null: Der Expertenmodus wurde nicht angefasst, es gelten die Werte des
  // Presets. Sonst die Eingaben als Text, so wie sie in den Feldern stehen.
  const [experten, setExperten] = useState<ExpertenEingabe | null>(null);
  // null: Die Ontologie wurde nicht angefasst, es gilt die Vorgabe.
  const [ontologie, setOntologie] = useState<OntologieEingabe | null>(null);
  const ontologieWerte = ontologie ?? ONTOLOGIE_VORGABE;
  const ontologieFehler = kind === "graph" && graphExtraktionVerfuegbar ? pruefeOntologieEingabe(ontologieWerte) : {};

  const aktivesPreset = presets.find((eintrag) => eintrag.id === preset) ?? presets[0];
  const expertenWerte = experten ?? (aktivesPreset ? vorgaben(aktivesPreset) : null);
  const expertenFehler =
    aktivesPreset && expertenWerte ? pruefeExperten(expertenWerte, aktivesPreset) : {};
  const expertenGueltig =
    kind !== "vector" || Object.keys(expertenFehler).length === 0;

  const bereit =
    name.trim().length >= 2 && sizeClassId && expertenGueltig && Object.keys(ontologieFehler).length === 0 && !gesperrt;

  function waehlePreset(id: Preset["id"]) {
    setPreset(id);
    // Die Vorgaben haengen am Preset; alte Abweichungen zu einem anderen
    // Preset waeren hier irrefuehrend.
    setExperten(null);
  }

  function setzeExperten(feld: VerarbeitungsFeld, wert: string) {
    if (!aktivesPreset) return;
    setExperten({ ...(experten ?? vorgaben(aktivesPreset)), [feld]: wert });
  }

  function verarbeitung(): VerarbeitungOverride | null {
    if (kind !== "vector" || !experten) return null;
    return {
      zielGroesse: Number(experten.zielGroesse),
      ueberlappung: Number(experten.ueberlappung),
      topK: Number(experten.topK),
      minScore: Number(experten.minScore.replace(",", ".")),
      rerank: experten.rerank !== "0",
      minRerank: Number(experten.minRerank.replace(",", ".")),
    };
  }

  return (
    <div className="anlegen">
      <div className="feld">
        <label htmlFor="sammlung-name">Name</label>
        <input
          id="sammlung-name"
          type="text"
          value={name}
          maxLength={80}
          placeholder="z. B. Buergerservice — Gebuehren"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="feld">
        <label htmlFor="sammlung-beschreibung">
          Was ist darin enthalten?{" "}
          <span className="feld-zusatz">
            Optional, aber hilfreich: Der Assistent entscheidet daran, wann er hier sucht.
          </span>
        </label>
        <textarea
          id="sammlung-beschreibung"
          value={beschreibung}
          rows={2}
          maxLength={400}
          placeholder="z. B. Gebuehrenordnungen und Preislisten des Buergeramts, Stand 2026"
          onChange={(e) => setBeschreibung(e.target.value)}
        />
      </div>

      <fieldset className="feld auswahl">
        <legend>Art der Sammlung</legend>
        <p className="feld-zusatz">
          Dokumente werden durchsucht, Tabellen per SQL und Graphen per Cypher abgefragt.
          Die Wahl gilt fuer die ganze Sammlung und laesst sich spaeter nicht aendern.
        </p>

        <div className="karten-auswahl">
          {COLLECTION_KINDS.map((eintrag) => {
            const nichtVerfuegbar = eintrag === "graph" && !graphVerfuegbar;
            const klassenname = [
              "wahlkarte",
              eintrag === kind ? "aktiv" : "",
              nichtVerfuegbar ? "gesperrt" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <label key={eintrag} className={klassenname}>
                <input
                  type="radio"
                  name="kind"
                  value={eintrag}
                  checked={eintrag === kind}
                  disabled={nichtVerfuegbar}
                  onChange={() => setKind(eintrag)}
                />
                <span className="wahlkarte-titel">{KIND_LABEL[eintrag]}</span>
                <span className="wahlkarte-kurz">
                  {eintrag === "graph" && graphExtraktionVerfuegbar
                    ? "Cypher-Skripte oder Dokumente (PDF, DOCX, XLSX), aus denen die KI Knoten und Kanten gewinnt; die KI schreibt Cypher."
                    : KIND_DESCRIPTION[eintrag]}
                </span>
                {nichtVerfuegbar && (
                  <span className="wahlkarte-beispiele">
                    Nicht verfuegbar: FALKORDB_URL ist auf dieser Instanz nicht gesetzt.
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      {kind === "graph" && graphExtraktionVerfuegbar && (
        <Ontologieformular
          werte={ontologieWerte}
          fehler={ontologieFehler}
          angefasst={ontologie !== null}
          onAendern={(aenderung) => setOntologie({ ...ontologieWerte, ...aenderung })}
          onZuruecksetzen={() => setOntologie(null)}
        />
      )}

      {/* Das Preset steuert das Zerlegen von Text — fuer Tabellen und Graphen
          gibt es nichts zu waehlen, der Server setzt dort den Standardwert. */}
      {kind === "vector" && (
        <fieldset className="feld auswahl">
          <legend>Um welche Art von Unterlagen handelt es sich?</legend>
          <p className="feld-zusatz">
            Danach richtet sich, wie die Dokumente in durchsuchbare Abschnitte zerlegt
            werden. Die Wahl gilt fuer die ganze Sammlung und laesst sich spaeter nicht
            aendern.
          </p>

          <div className="karten-auswahl">
            {presets.map((eintrag) => (
              <label
                key={eintrag.id}
                className={eintrag.id === preset ? "wahlkarte aktiv" : "wahlkarte"}
              >
                <input
                  type="radio"
                  name="preset"
                  value={eintrag.id}
                  checked={eintrag.id === preset}
                  onChange={() => waehlePreset(eintrag.id)}
                />
                <span className="wahlkarte-titel">{eintrag.label}</span>
                <span className="wahlkarte-kurz">{eintrag.kurz}</span>
                <span className="wahlkarte-beispiele">{eintrag.beispiele}</span>
              </label>
            ))}
          </div>

          {aktivesPreset && expertenWerte && (
            <Expertenmodus
              preset={aktivesPreset}
              werte={expertenWerte}
              fehler={expertenFehler}
              rerankVerfuegbar={rerankVerfuegbar}
              angefasst={experten !== null}
              onAendern={setzeExperten}
              onZuruecksetzen={() => setExperten(null)}
            />
          )}
        </fieldset>
      )}

      <fieldset className="feld auswahl">
        <legend>Groesse</legend>
        <p className="feld-zusatz">
          Ihr Plan schaltet die folgenden Klassen frei. Die Grenzen gelten je Sammlung.
        </p>

        <div className="karten-auswahl">
          {klassen.map((klasse) => (
            <label
              key={klasse.id}
              className={klasse.id === sizeClassId ? "wahlkarte aktiv" : "wahlkarte"}
            >
              <input
                type="radio"
                name="groessenklasse"
                value={klasse.id}
                checked={klasse.id === sizeClassId}
                onChange={() => setSizeClassId(klasse.id)}
              />
              <span className="wahlkarte-titel">{klasse.label}</span>
              <span className="wahlkarte-kurz">
                {klasse.maxDocuments} Dokumente · {klasse.maxPagesPerDocument} Seiten je
                Dokument
              </span>
              <span className="wahlkarte-beispiele">
                Insgesamt {klasse.maxTotalPages.toLocaleString("de-DE")} Seiten ·{" "}
                {Math.round(klasse.maxFileBytes / (1024 * 1024))} MB je Datei
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="knopfzeile">
        <button
          className="knopf"
          disabled={!bereit}
          onClick={() =>
            onAnlegen({
              name,
              beschreibung,
              kind,
              preset,
              sizeClassId,
              verarbeitung: verarbeitung(),
              ontologie: kind === "graph" ? ontologie : null,
            })
          }
        >
          {gesperrt ? "Wird angelegt …" : "Sammlung anlegen"}
        </button>
        <button className="knopf knopf-sekundaer" onClick={onAbbrechen}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

// --- Expertenmodus ----------------------------------------------------------

/**
 * Die Felder als Text, so wie sie in den Eingabefeldern stehen. Der
 * Reranker-Schalter steht als "1" oder "0" darin, damit alle Felder gleich
 * behandelt werden koennen.
 */
type ExpertenEingabe = Record<VerarbeitungsFeld, string>;

type ExpertenFehler = Partial<Record<VerarbeitungsFeld, string>>;

const dezimal = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Die Vorgaben des Presets in Feldform. */
function vorgaben(preset: Preset): ExpertenEingabe {
  return {
    zielGroesse: String(preset.zielGroesse),
    ueberlappung: String(preset.ueberlappung),
    topK: String(preset.topK),
    minScore: STANDARD_MIN_SCORE.toFixed(2),
    rerank: "1",
    minRerank: STANDARD_MIN_RERANK.toFixed(2),
  };
}

/**
 * Plausibilitaet im Browser, damit der Knopf erst freigegeben wird, wenn die
 * Werte durchgehen. Die verbindliche Pruefung macht der Server
 * (pruefeVerarbeitung in lib/presets.ts) mit denselben Grenzen.
 */
function pruefeExperten(werte: ExpertenEingabe, preset: Preset): ExpertenFehler {
  const fehler: ExpertenFehler = {};

  const zielGroesse = ganzzahl(werte.zielGroesse);
  const { min: minGroesse, max: maxGroesse } = VERARBEITUNG_GRENZEN.zielGroesse;
  if (zielGroesse === null || zielGroesse < minGroesse || zielGroesse > maxGroesse) {
    fehler.zielGroesse = `Ganze Zahl zwischen ${minGroesse} und ${maxGroesse.toLocaleString("de-DE")}.`;
  }

  const ueberlappung = ganzzahl(werte.ueberlappung);
  const hoechstens = maxUeberlappung(zielGroesse ?? preset.zielGroesse);
  if (ueberlappung === null || ueberlappung < 0 || ueberlappung > hoechstens) {
    fehler.ueberlappung = `Ganze Zahl zwischen 0 und ${hoechstens} (unter der halben Abschnittsgroesse).`;
  }

  const topK = ganzzahl(werte.topK);
  const { min: minTopK, max: maxTopK } = VERARBEITUNG_GRENZEN.topK;
  if (topK === null || topK < minTopK || topK > maxTopK) {
    fehler.topK = `Ganze Zahl zwischen ${minTopK} und ${maxTopK}.`;
  }

  const minScore = Number(werte.minScore.trim().replace(",", "."));
  const { min: minSchwelle, max: maxSchwelle } = VERARBEITUNG_GRENZEN.minScore;
  if (
    werte.minScore.trim() === "" ||
    !Number.isFinite(minScore) ||
    minScore < minSchwelle ||
    minScore > maxSchwelle
  ) {
    fehler.minScore = `Zahl zwischen ${minSchwelle} und ${maxSchwelle}, z. B. 0,80.`;
  }

  const minRerank = Number(werte.minRerank.trim().replace(",", "."));
  const { min: minRelevanz, max: maxRelevanz } = VERARBEITUNG_GRENZEN.minRerank;
  if (
    werte.minRerank.trim() === "" ||
    !Number.isFinite(minRerank) ||
    minRerank < minRelevanz ||
    minRerank > maxRelevanz
  ) {
    fehler.minRerank = `Zahl zwischen ${minRelevanz} und ${maxRelevanz}, z. B. 0,05.`;
  }

  return fehler;
}

function ganzzahl(text: string): number | null {
  if (text.trim() === "") return null;
  const zahl = Number(text);
  return Number.isInteger(zahl) ? zahl : null;
}

/**
 * Zugeklappt eine Zeile, aufgeklappt vier Zahlenfelder — mit Reranker zwei
 * mehr. Die Werte sind mit dem Preset vorbelegt; wer nichts anfasst, bekommt
 * eine gewoehnliche Preset-Sammlung.
 */
function Expertenmodus({
  preset,
  werte,
  fehler,
  rerankVerfuegbar,
  angefasst,
  onAendern,
  onZuruecksetzen,
}: {
  preset: Preset;
  werte: ExpertenEingabe;
  fehler: ExpertenFehler;
  rerankVerfuegbar: boolean;
  angefasst: boolean;
  onAendern: (feld: VerarbeitungsFeld, wert: string) => void;
  onZuruecksetzen: () => void;
}) {
  const felder: {
    id: VerarbeitungsFeld;
    label: string;
    zusatz: string;
    step: number;
    min: number;
    max: number;
    inputMode: "numeric" | "decimal";
  }[] = [
    {
      id: "zielGroesse",
      label: "Abschnittsgroesse",
      zusatz: "Zeichen",
      step: 1,
      min: VERARBEITUNG_GRENZEN.zielGroesse.min,
      max: VERARBEITUNG_GRENZEN.zielGroesse.max,
      inputMode: "numeric",
    },
    {
      id: "ueberlappung",
      label: "Ueberlappung",
      zusatz: "Zeichen",
      step: 1,
      min: VERARBEITUNG_GRENZEN.ueberlappung.min,
      max: maxUeberlappung(ganzzahl(werte.zielGroesse) ?? preset.zielGroesse),
      inputMode: "numeric",
    },
    {
      id: "topK",
      label: "Treffer je Suche",
      zusatz: "Abschnitte",
      step: 1,
      min: VERARBEITUNG_GRENZEN.topK.min,
      max: VERARBEITUNG_GRENZEN.topK.max,
      inputMode: "numeric",
    },
    {
      id: "minScore",
      label: "Mindest-Aehnlichkeit",
      zusatz: "0 bis 1",
      step: 0.01,
      min: VERARBEITUNG_GRENZEN.minScore.min,
      max: VERARBEITUNG_GRENZEN.minScore.max,
      inputMode: "decimal",
    },
  ];
  const rerankAn = werte.rerank !== "0";
  if (rerankVerfuegbar && rerankAn) {
    felder.push({
      id: "minRerank",
      label: "Mindest-Relevanz (Reranker)",
      zusatz: "0 bis 1",
      step: 0.01,
      min: VERARBEITUNG_GRENZEN.minRerank.min,
      max: VERARBEITUNG_GRENZEN.minRerank.max,
      inputMode: "decimal",
    });
  }

  return (
    <details className="experten">
      <summary>Expertenmodus{angefasst ? " · angepasst" : ""}</summary>

      <p className="feld-zusatz">
        Vorbelegt mit den Werten von „{preset.label}“. Sie gelten fuer die ganze Sammlung
        und lassen sich nachtraeglich nicht aendern — die Abschnitte einer Sammlung
        muessen vergleichbar lang bleiben, sonst hinge die Rangfolge der Treffer von der
        Laenge ab statt vom Inhalt. Ein Wechsel des Presets setzt die Werte zurueck.
      </p>

      {rerankVerfuegbar && (
        <label className="experten-schalter">
          <input
            type="checkbox"
            checked={rerankAn}
            onChange={(e) => onAendern("rerank", e.target.checked ? "1" : "0")}
          />{" "}
          Reranker verwenden
          <span className="feld-zusatz">
            {" "}
            — ordnet die Treffer nach ihrer Relevanz zur Frage neu, statt nur nach
            Aehnlichkeit der Einbettung. Kostet je Frage einen kurzen Zusatzschritt.
          </span>
        </label>
      )}

      <div className="experten-raster">
        {felder.map((feld) => {
          const meldung = fehler[feld.id];
          const eingabeId = `experten-${feld.id}`;
          return (
            <div key={feld.id} className="feld">
              <label htmlFor={eingabeId}>
                {feld.label} <span className="feld-zusatz">{feld.zusatz}</span>
              </label>
              <input
                id={eingabeId}
                type="number"
                inputMode={feld.inputMode}
                min={feld.min}
                max={feld.max}
                step={feld.step}
                value={werte[feld.id]}
                aria-invalid={meldung ? true : undefined}
                aria-describedby={meldung ? `${eingabeId}-fehler` : undefined}
                onChange={(e) => onAendern(feld.id, e.target.value)}
              />
              {meldung && (
                <p id={`${eingabeId}-fehler`} className="feld-fehler">
                  {meldung}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="experten-fuss">
        <span className="feld-zusatz">
          Vorgabe {preset.label}: {preset.zielGroesse.toLocaleString("de-DE")} Zeichen ·{" "}
          {preset.ueberlappung} Ueberlappung · {preset.topK} Treffer · ab{" "}
          {dezimal.format(STANDARD_MIN_SCORE)}
          {rerankVerfuegbar ? ` · Reranker an, Relevanz ab ${dezimal.format(STANDARD_MIN_RERANK)}` : ""}
        </span>
        <button
          type="button"
          className="knopf-schlicht"
          disabled={!angefasst}
          onClick={onZuruecksetzen}
        >
          Auf Preset zuruecksetzen
        </button>
      </div>
    </details>
  );
}

// --- Ontologie (Graph-Extraktion) -------------------------------------------

/** Listen als Text, eine Zeile je Eintrag — so stehen sie im Formular. */
type OntologieEingabe = { labels: string; beziehungen: string; frei: boolean };

type OntologieFehler = Partial<Record<"labels" | "beziehungen", string>>;

const ONTOLOGIE_VORGABE: OntologieEingabe = {
  labels: alsZeilen(STANDARD_LABELS),
  beziehungen: alsZeilen(STANDARD_BEZIEHUNGEN),
  frei: false,
};

function eintraege(text: string): string[] {
  return text.split(/[,\n;]/).map((eintrag) => eintrag.trim()).filter(Boolean);
}

/**
 * Plausibilitaet im Browser; verbindlich prueft der Server (pruefeOntologie
 * in lib/graph-ontologie.ts) mit denselben Mustern.
 */
function pruefeOntologieEingabe(werte: OntologieEingabe): OntologieFehler {
  const fehler: OntologieFehler = {};
  const reserviert = Object.values(PROVENIENZ) as string[];

  const labels = eintraege(werte.labels);
  if (labels.length === 0) fehler.labels = "Mindestens eine Knotenart, z. B. Person.";
  else if (labels.length > ONTOLOGIE_MAX_EINTRAEGE) fehler.labels = `Hoechstens ${ONTOLOGIE_MAX_EINTRAEGE} Knotenarten.`;
  else {
    const falsch = labels.find((label) => !LABEL_MUSTER.test(label) || reserviert.includes(label));
    if (falsch) fehler.labels = `„${falsch}“: Grossbuchstabe am Anfang, dann Buchstaben, Ziffern oder Unterstrich, ohne Umlaute; Quelle und Abschnitt sind reserviert.`;
  }

  const beziehungen = eintraege(werte.beziehungen);
  if (beziehungen.length > ONTOLOGIE_MAX_EINTRAEGE) fehler.beziehungen = `Hoechstens ${ONTOLOGIE_MAX_EINTRAEGE} Beziehungstypen.`;
  else {
    const falsch = beziehungen.find((typ) => !BEZIEHUNG_MUSTER.test(typ) || reserviert.includes(typ));
    if (falsch) fehler.beziehungen = `„${falsch}“: Grossbuchstaben, Ziffern und Unterstrich, ohne Umlaute, z. B. ARBEITET_FUER.`;
  }

  return fehler;
}

/**
 * Zugeklappt eine Zeile, aufgeklappt zwei Listen und ein Schalter. Die
 * Vorgabe passt fuer Verwaltungs- und Unternehmensunterlagen; wer anderes
 * modelliert, traegt seine Typen ein. Die Ontologie gilt fuer alle Dokumente
 * der Sammlung und laesst sich nachtraeglich nicht aendern — der Graph
 * entsteht aus ihr, und ein Wechsel machte die vorhandenen Knoten
 * unvergleichbar mit den neuen.
 */
function Ontologieformular({
  werte,
  fehler,
  angefasst,
  onAendern,
  onZuruecksetzen,
}: {
  werte: OntologieEingabe;
  fehler: OntologieFehler;
  angefasst: boolean;
  onAendern: (aenderung: Partial<OntologieEingabe>) => void;
  onZuruecksetzen: () => void;
}) {
  return (
    <details className="experten">
      <summary>Ontologie der Extraktion{angefasst ? " · angepasst" : ""}</summary>

      <p className="feld-zusatz">
        Welche Knotenarten und Beziehungstypen die KI aus Dokumenten gewinnen darf. Die
        Vorgabe deckt Personen, Organisationen, Orte, Ereignisse, Vorschriften, Begriffe,
        Daten und Betraege ab. Die Wahl gilt fuer die ganze Sammlung und laesst sich
        spaeter nicht aendern. Cypher-Skripte sind davon unabhaengig.
      </p>

      <div className="experten-raster">
        <div className="feld">
          <label htmlFor="ontologie-labels">
            Knotenarten <span className="feld-zusatz">eine je Zeile</span>
          </label>
          <textarea
            id="ontologie-labels"
            rows={6}
            value={werte.labels}
            aria-invalid={fehler.labels ? true : undefined}
            aria-describedby={fehler.labels ? "ontologie-labels-fehler" : undefined}
            onChange={(e) => onAendern({ labels: e.target.value })}
          />
          {fehler.labels && (
            <p id="ontologie-labels-fehler" className="feld-fehler">{fehler.labels}</p>
          )}
        </div>
        <div className="feld">
          <label htmlFor="ontologie-beziehungen">
            Beziehungstypen <span className="feld-zusatz">einer je Zeile</span>
          </label>
          <textarea
            id="ontologie-beziehungen"
            rows={6}
            value={werte.beziehungen}
            aria-invalid={fehler.beziehungen ? true : undefined}
            aria-describedby={fehler.beziehungen ? "ontologie-beziehungen-fehler" : undefined}
            onChange={(e) => onAendern({ beziehungen: e.target.value })}
          />
          {fehler.beziehungen && (
            <p id="ontologie-beziehungen-fehler" className="feld-fehler">{fehler.beziehungen}</p>
          )}
        </div>
      </div>

      <label className="experten-schalter">
        <input
          type="checkbox"
          checked={werte.frei}
          onChange={(e) => onAendern({ frei: e.target.checked })}
        />{" "}
        Weitere Typen zulassen
        <span className="feld-zusatz">
          {" "}
          — die KI darf Knotenarten und Beziehungstypen ergaenzen, die im Text vorkommen,
          aber oben fehlen. Ergibt einen reicheren, aber weniger einheitlichen Graphen.
        </span>
      </label>

      <div className="experten-fuss">
        <span className="feld-zusatz">
          Herkunft vergibt die Anwendung selbst: je Datei ein Knoten „Quelle“, je Textabschnitt
          ein Knoten „Abschnitt“.
        </span>
        <button
          type="button"
          className="knopf-schlicht"
          disabled={!angefasst}
          onClick={onZuruecksetzen}
        >
          Auf Vorgabe zuruecksetzen
        </button>
      </div>
    </details>
  );
}
