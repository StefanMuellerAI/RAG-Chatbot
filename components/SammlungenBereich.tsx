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
import type { Preset } from "@/lib/presets";

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
                  {verarbeitung} · {sammlung.documentCount}{" "}
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

  const bereit = name.trim().length >= 2 && sizeClassId && !gesperrt;

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
                  onChange={() => setPreset(eintrag.id)}
                />
                <span className="wahlkarte-titel">{eintrag.label}</span>
                <span className="wahlkarte-kurz">{eintrag.kurz}</span>
                <span className="wahlkarte-beispiele">{eintrag.beispiele}</span>
              </label>
            ))}
          </div>
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
          onClick={() => onAnlegen({ name, beschreibung, kind, preset, sizeClassId })}
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
