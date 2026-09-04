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
};

export default function SammlungenBereich({
  sammlungen,
  klassen,
  presets,
  graphVerfuegbar,
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
  gesperrt,
  onAbbrechen,
  onAnlegen,
}: {
  klassen: SizeClass[];
  presets: Preset[];
  graphVerfuegbar: boolean;
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

  const aktivesPreset = presets.find((eintrag) => eintrag.id === preset) ?? presets[0];
  const expertenWerte = experten ?? (aktivesPreset ? vorgaben(aktivesPreset) : null);
  const expertenFehler =
    aktivesPreset && expertenWerte ? pruefeExperten(expertenWerte, aktivesPreset) : {};
  const expertenGueltig =
    kind !== "vector" || Object.keys(expertenFehler).length === 0;

  const bereit = name.trim().length >= 2 && sizeClassId && expertenGueltig && !gesperrt;

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
                <span className="wahlkarte-kurz">{KIND_DESCRIPTION[eintrag]}</span>
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

/** Die vier Felder als Text, so wie sie in den Eingabefeldern stehen. */
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

  return fehler;
}

function ganzzahl(text: string): number | null {
  if (text.trim() === "") return null;
  const zahl = Number(text);
  return Number.isInteger(zahl) ? zahl : null;
}

/**
 * Zugeklappt eine Zeile, aufgeklappt vier Zahlenfelder. Die Werte sind mit
 * dem Preset vorbelegt; wer nichts anfasst, bekommt eine gewoehnliche
 * Preset-Sammlung.
 */
function Expertenmodus({
  preset,
  werte,
  fehler,
  angefasst,
  onAendern,
  onZuruecksetzen,
}: {
  preset: Preset;
  werte: ExpertenEingabe;
  fehler: ExpertenFehler;
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

  return (
    <details className="experten">
      <summary>Expertenmodus{angefasst ? " · angepasst" : ""}</summary>

      <p className="feld-zusatz">
        Vorbelegt mit den Werten von „{preset.label}“. Sie gelten fuer die ganze Sammlung
        und lassen sich nachtraeglich nicht aendern — die Abschnitte einer Sammlung
        muessen vergleichbar lang bleiben, sonst hinge die Rangfolge der Treffer von der
        Laenge ab statt vom Inhalt. Ein Wechsel des Presets setzt die Werte zurueck.
      </p>

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
