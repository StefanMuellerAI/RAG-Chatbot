"use client";

import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { aktualisiereSammlungAktion } from "@/app/sammlungen/actions";
import { useBestaetigung } from "@/components/BestaetigungsDialog";
import SchemaCard from "@/components/SchemaCard";
import {
  KIND_EXTENSIONS,
  KIND_LABEL,
  KIND_UNIT,
  type CollectionKind,
} from "@/lib/collection-kinds";
import type { SammlungMitKlasse } from "@/lib/collections";
import type { DocumentRecord } from "@/lib/db/schema";
import type { Verarbeitung } from "@/lib/presets";

/**
 * Eine Sammlung: Dokumente einpflegen, Fortschritt verfolgen, entfernen.
 *
 * Die Verarbeitung laeuft nicht mehr innerhalb des Upload-Requests, sondern als
 * eigener Ablauf auf dem Server. Diese Ansicht fragt deshalb den Zustand ab,
 * statt auf eine Antwort zu warten — ein Dokument mit hunderten Seiten braucht
 * laenger, als ein Browser sinnvoll wartet.
 *
 * Der Ablauf ist fuer alle Sammlungstypen derselbe (anmelden, hochladen,
 * verarbeiten lassen, abfragen); nur Endungen, Texte und die Bezeichnung der
 * Einheiten haengen vom Typ ab.
 */

const BESTAETIGUNG = "LÖSCHEN";
/** Abfrageabstand, solange etwas laeuft. */
const ABFRAGE_MS = 2_500;

type Texte = {
  /** Ueberschrift der Upload-Karte. */
  titel: string;
  /** Erklaerender Satz unter der Ueberschrift; Grenzen haengt der Aufrufer an. */
  hinweis: string;
  /** Zeile unter der Ablagezone. */
  grenze: string;
  /** Leerer Bestand. */
  leer: string;
  /** Zustand eines fertigen Dokuments. */
  fertig: string;
  /** Was das Loeschen der Sammlung entfernt. */
  loeschen: string;
};

/**
 * Die Grenzen fuer CSV und Cypher stehen hier als Text und nicht als Import
 * aus lib/csv.ts bzw. lib/cypher-script.ts: Das eine zoege papaparse in das
 * Browser-Bundle, und beides sind Konstanten, die sich nicht von selbst
 * aendern (CSV_MAX_BYTES, CSV_MAX_ROWS, CYPHER_MAX_BYTES, CYPHER_MAX_STATEMENTS).
 */
const TEXTE: Record<CollectionKind, Texte> = {
  vector: {
    titel: "Dokumente einpflegen",
    hinweis: "PDF, DOCX, XLSX und MP3. MP3 wird transkribiert; lange Aufnahmen intern in Teilen.",
    grenze: "Mehrere Dateien gleichzeitig moeglich",
    leer: "Noch nichts eingepflegt. Zu dieser Sammlung kann der Chat derzeit nichts sagen.",
    fertig: "Durchsuchbar",
    loeschen: "alle Dokumente dieser Sammlung, alle Abschnitte und alle Originaldateien",
  },
  sql: {
    titel: "Tabellen aus CSV anlegen",
    hinweis:
      "Eine CSV-Datei wird zu einer Tabelle (Name aus dem Dateinamen). Kopfzeile ist " +
      "Pflicht; Trennzeichen und Dezimalkomma werden erkannt. Eine Datei mit gleichem " +
      "Namen ersetzt die Tabelle. Fuers Kontingent zaehlen 50 Zeilen als eine Seite.",
    grenze: "Mehrere Dateien gleichzeitig moeglich · max. 20 MB und 200.000 Zeilen je Datei",
    leer: "Noch keine Tabelle. Die KI kann in dieser Sammlung derzeit kein SQL ausfuehren.",
    fertig: "Als Tabelle abfragbar",
    loeschen: "alle Tabellen dieser Sammlung samt Datenbank und alle Originaldateien",
  },
  graph: {
    titel: "Graph aus Cypher-Skript aufbauen",
    hinweis:
      "Ein Skript mit CREATE-/MERGE-Statements (Neo4j-Stil, durch Semikolon getrennt) " +
      "wird in den Graphen dieser Sammlung eingespielt. CREATE CONSTRAINT und CREATE INDEX " +
      "werden uebersprungen — FalkorDB kennt sie nicht als Cypher. Mehrere Skripte ergaenzen sich. " +
      "Fuers Kontingent zaehlen 3.000 Zeichen als eine Seite.",
    grenze: `Endungen ${KIND_EXTENSIONS.graph.join(", ")} · max. 5 MB und 5.000 Statements je Datei`,
    leer: "Noch kein Skript. Die KI kann in dieser Sammlung derzeit kein Cypher ausfuehren.",
    fertig: "Im Graphen",
    loeschen: "den Graphen dieser Sammlung, alle Skripte und alle Originaldateien",
  },
};

type Eigenschaften = {
  sammlung: SammlungMitKlasse;
  dokumente: DocumentRecord[];
  /** Preset samt Abweichungen aus dem Expertenmodus. */
  verarbeitung: Verarbeitung;
};

type Vorgang = {
  key: string;
  filename: string;
  text: string;
  fehler: boolean;
  dokumentId?: string;
};

/**
 * Die Warteschlange oben ist lokaler Upload-Fortschritt. Sobald dasselbe
 * Dokument im Bestand fertig oder fehlgeschlagen ist, gehoert die Zeile nicht
 * mehr dorthin — sonst bleibt "In der Verarbeitung" stehen, obwohl die Tabelle
 * darunter bereits "Durchsuchbar" zeigt.
 */
function abgleichen(vorgaenge: Vorgang[], dokumente: DocumentRecord[]): Vorgang[] {
  const naechste = vorgaenge.flatMap((vorgang) => {
    const dokument = vorgang.dokumentId
      ? dokumente.find((eintrag) => eintrag.id === vorgang.dokumentId)
      : dokumente.find((eintrag) => eintrag.filename === vorgang.filename);

    if (!dokument) return [vorgang];
    if (dokument.status === "fertig") return [];
    if (dokument.status === "fehler") {
      return [{ ...vorgang, text: dokument.error ?? "Fehlgeschlagen", fehler: true }];
    }
    return [vorgang];
  });

  if (
    naechste.length === vorgaenge.length &&
    naechste.every((eintrag, i) => eintrag === vorgaenge[i])
  ) {
    return vorgaenge;
  }

  return naechste;
}

export default function SammlungDetail({ sammlung, dokumente, verarbeitung }: Eigenschaften) {
  const router = useRouter();

  const kind = sammlung.kind;
  const endungen = KIND_EXTENSIONS[kind];
  const texte = TEXTE[kind];
  const einheit = KIND_UNIT[kind];

  const [liste, setListe] = useState(dokumente);
  const [vorgaenge, setVorgaenge] = useState<Vorgang[]>([]);
  const [ueberAblage, setUeberAblage] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [bestaetigung, setBestaetigung] = useState("");
  const [loeschtSammlung, setLoeschtSammlung] = useState(false);
  const [bearbeitet, setBearbeitet] = useState(false);
  const { bestaetige, dialog } = useBestaetigung();

  // Name und Beschreibung sofort so zeigen, wie sie gespeichert werden; die
  // Action bringt die Seite danach ohnehin frisch mit. Scheitert sie, faellt
  // useOptimistic am Ende der Transition von selbst auf die Props zurueck.
  const [angaben, zeigeAngabenSofort] = useOptimistic(
    { name: sammlung.name, description: sammlung.description },
    (_bisher, neu: { name: string; description: string }) => neu,
  );
  const [speichertAngaben, starteSpeichern] = useTransition();

  function speichereAngaben(name: string, beschreibung: string) {
    setFehler(null);
    setBearbeitet(false);
    starteSpeichern(async () => {
      zeigeAngabenSofort({ name, description: beschreibung });
      try {
        const ergebnis = await aktualisiereSammlungAktion(sammlung.id, { name, beschreibung });
        if (!ergebnis.ok) {
          setFehler(ergebnis.fehler);
          setBearbeitet(true);
        }
      } catch (error) {
        setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
        setBearbeitet(true);
      }
    });
  }

  const laufendeAbfrage = useRef(false);

  const offen = liste.some(
    (dokument) => dokument.status === "wartet" || dokument.status === "laeuft",
  );

  // router.refresh() nach dem letzten Abschluss liefert die fertigen Saetze
  // als Props. Die Warteschlange oben kennt die nur, wenn wir sie hier
  // dagegenhalten — die Polling-Schleife laeuft dann schon nicht mehr.
  //
  // Waehrend des Renderns statt in einem Effekt: So entsteht kein zweiter
  // Renderdurchlauf mit veralteter Warteschlange, und React verwirft das
  // gerade laufende Ergebnis zugunsten des angepassten Zustands.
  const [gesehen, setGesehen] = useState(dokumente);
  if (dokumente !== gesehen) {
    setGesehen(dokumente);
    setVorgaenge(abgleichen(vorgaenge, dokumente));
  }

  const aktualisiere = useCallback(async () => {
    // Ueberholende Abfragen vermeiden: bei langsamer Verbindung wuerden sich
    // sonst mehrere ueberlagern und die Liste hin und her springen.
    if (laufendeAbfrage.current) return;
    laufendeAbfrage.current = true;

    try {
      const antwort = await fetch(`/api/collections/${sammlung.id}/dokumente`);
      if (!antwort.ok) return;
      const daten = (await antwort.json()) as { dokumente: DocumentRecord[] };
      setListe(daten.dokumente);
      setVorgaenge((bisher) => abgleichen(bisher, daten.dokumente));
    } catch {
      // Ein misslungener Abfrageversuch ist kein Anlass fuer eine Fehlermeldung;
      // der naechste folgt in wenigen Sekunden.
    } finally {
      laufendeAbfrage.current = false;
    }
  }, [sammlung.id]);

  // Nur abfragen, solange tatsaechlich etwas laeuft. Eine Ansicht, die im
  // Ruhezustand alle zwei Sekunden fragt, waere bei 15.000 Nutzern eine
  // erhebliche Grundlast ohne jeden Nutzen.
  useEffect(() => {
    if (!offen) {
      // Zaehler in der Kopfzeile stammen aus dem Server-Rendering und sind nach
      // dem letzten Abschluss veraltet.
      router.refresh();
      return;
    }

    const zeitgeber = setInterval(() => void aktualisiere(), ABFRAGE_MS);
    return () => clearInterval(zeitgeber);
  }, [offen, aktualisiere, router]);

  async function verarbeite(dateien: File[]) {
    setFehler(null);

    for (const datei of dateien) {
      const key = `${datei.name}-${datei.lastModified}-${datei.size}`;

      if (!endungen.some((endung) => datei.name.toLowerCase().endsWith(endung))) {
        setzeVorgang({
          key,
          filename: datei.name,
          text: `Format nicht unterstuetzt (nur ${endungen.join(", ")})`,
          fehler: true,
        });
        continue;
      }

      try {
        setzeVorgang({ key, filename: datei.name, text: "Wird angemeldet …", fehler: false });

        // Schritt 1: Kontingent pruefen und Ablagepfad erhalten. Erst danach
        // gibt die Token-Route einen Upload frei.
        const anmeldung = await fetch(`/api/collections/${sammlung.id}/dokumente`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: datei.name,
            contentType: datei.type,
            sizeBytes: datei.size,
          }),
        });

        const angemeldet = await anmeldung.json().catch(() => ({}));
        if (!anmeldung.ok) throw new Error(angemeldet.error ?? `Status ${anmeldung.status}`);

        const dokumentId = angemeldet.dokument.id as string;

        setzeVorgang({
          key,
          filename: datei.name,
          text: "Wird hochgeladen …",
          fehler: false,
          dokumentId,
        });

        // Schritt 2: direkt vom Browser in den Blob-Store — so greift das
        // 4,5-MB-Limit fuer Request-Bodies von Serverless-Funktionen nicht.
        await upload(angemeldet.blobPfad, datei, {
          access: "private",
          handleUploadUrl: "/api/upload",
          contentType: datei.type || undefined,
        });

        // Schritt 3: Verarbeitung anstossen. Kommt sofort zurueck.
        const angestossen = await fetch(`/api/documents/${dokumentId}/verarbeiten`, {
          method: "POST",
        });

        if (!angestossen.ok) {
          const daten = await angestossen.json().catch(() => ({}));
          throw new Error(daten.error ?? `Status ${angestossen.status}`);
        }

        setzeVorgang({
          key,
          filename: datei.name,
          text: "In der Verarbeitung",
          fehler: false,
          dokumentId,
        });
      } catch (error) {
        setzeVorgang({
          key,
          filename: datei.name,
          text: error instanceof Error ? error.message : "Unbekannter Fehler.",
          fehler: true,
        });
      }
    }

    await aktualisiere();
    router.refresh();
  }

  function setzeVorgang(vorgang: Vorgang) {
    setVorgaenge((bisher) => {
      const index = bisher.findIndex((eintrag) => eintrag.key === vorgang.key);
      if (index === -1) return [...bisher, vorgang];
      const kopie = [...bisher];
      kopie[index] = vorgang;
      return kopie;
    });
  }

  async function loescheDokument(dokument: DocumentRecord) {
    const ja = await bestaetige({
      titel: `"${dokument.filename}" entfernen?`,
      text: `Das Dokument verschwindet samt seiner ${einheit} aus der Sammlung. Die Datei laesst sich danach erneut hochladen.`,
      bestaetigen: "Entfernen",
    });
    if (!ja) return;
    setFehler(null);

    try {
      const antwort = await fetch(`/api/documents/${dokument.id}`, { method: "DELETE" });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? `Status ${antwort.status}`);

      await aktualisiere();
      router.refresh();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    }
  }

  async function wiederhole(dokument: DocumentRecord) {
    setFehler(null);

    try {
      const antwort = await fetch(`/api/documents/${dokument.id}/verarbeiten`, {
        method: "POST",
      });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? `Status ${antwort.status}`);

      await aktualisiere();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    }
  }

  async function loescheSammlung() {
    setLoeschtSammlung(true);
    setFehler(null);

    try {
      const antwort = await fetch(`/api/collections/${sammlung.id}`, { method: "DELETE" });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? `Status ${antwort.status}`);

      router.push("/sammlungen");
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
      setLoeschtSammlung(false);
    }
  }

  const abschnitteGesamt = liste.reduce((summe, dokument) => summe + dokument.chunkCount, 0);
  const klasse = sammlung.sizeClass;

  return (
    <>
      {fehler && <div className="meldung">{fehler}</div>}

      <p className="brotkrume">
        <Link href="/sammlungen">Sammlungen</Link> · {angaben.name}
      </p>

      <div className="karte">
        <h1 className="karte-titel">
          {angaben.name} <span className="marke">{klasse.id}</span>
          <span className={`typ-marke typ-${kind}`}>{KIND_LABEL[kind]}</span>
        </h1>

        {bearbeitet ? (
          <Angaben
            name={angaben.name}
            beschreibung={angaben.description}
            onSpeichern={speichereAngaben}
            onAbbrechen={() => setBearbeitet(false)}
          />
        ) : (
          <>
            <p className="hinweis-text" style={{ marginBottom: 10 }}>
              {angaben.description || "Keine Beschreibung hinterlegt."}
            </p>
            <button
              className="knopf-schlicht"
              disabled={speichertAngaben}
              onClick={() => setBearbeitet(true)}
            >
              {speichertAngaben ? "Wird gespeichert …" : "Name und Beschreibung aendern"}
            </button>
          </>
        )}

        <div className="kennzahlen" style={{ marginTop: 18 }}>
          <div className="kennzahl">
            <div className="kennzahl-wert">
              {liste.length}
              <span className="kennzahl-von"> / {klasse.maxDocuments}</span>
            </div>
            <div className="kennzahl-beschriftung">Dokumente</div>
          </div>
          <div className="kennzahl">
            <div className="kennzahl-wert">
              {sammlung.pageCount.toLocaleString("de-DE")}
              <span className="kennzahl-von">
                {" "}
                / {klasse.maxTotalPages.toLocaleString("de-DE")}
              </span>
            </div>
            <div className="kennzahl-beschriftung">Seiten</div>
          </div>
          <div className="kennzahl">
            <div className="kennzahl-wert">{abschnitteGesamt.toLocaleString("de-DE")}</div>
            <div className="kennzahl-beschriftung">{einheit}</div>
          </div>
          <div className="kennzahl">
            <div className="kennzahl-wert" style={{ fontSize: 17 }}>
              {kind === "vector" ? verarbeitung.label : KIND_LABEL[kind]}
            </div>
            <div className="kennzahl-beschriftung">
              {kind === "vector" ? "Verarbeitung" : "Art"}
            </div>
          </div>
        </div>

        {kind === "vector" && (
          <p className="hinweis-text verarbeitung-werte">
            {verarbeitung.zielGroesse.toLocaleString("de-DE")} Zeichen je Abschnitt ·{" "}
            {verarbeitung.ueberlappung} Zeichen Ueberlappung · {verarbeitung.topK} Treffer je
            Suche · Mindest-Aehnlichkeit {schwelle(verarbeitung.minScore)}
            {verarbeitung.angepasst
              ? " · im Expertenmodus angepasst"
              : " · Vorgaben des Presets"}
          </p>
        )}
      </div>

      {sammlung.schema && <SchemaCard schema={sammlung.schema} />}

      <div className="karte">
        <h2 className="karte-titel">{texte.titel}</h2>
        <p className="hinweis-text">
          {texte.hinweis} {kind === "vector" ? `${verarbeitung.kurz} ` : ""}Hoechstens{" "}
          {klasse.maxPagesPerDocument} Seiten und{" "}
          {Math.round(klasse.maxFileBytes / (1024 * 1024))} MB je Datei.
        </p>

        <label
          className={ueberAblage ? "ablage aktiv" : "ablage"}
          onDragOver={(ereignis) => {
            ereignis.preventDefault();
            setUeberAblage(true);
          }}
          onDragLeave={() => setUeberAblage(false)}
          onDrop={(ereignis) => {
            ereignis.preventDefault();
            setUeberAblage(false);
            void verarbeite(Array.from(ereignis.dataTransfer.files));
          }}
        >
          <input
            type="file"
            multiple
            accept={endungen.join(",")}
            style={{ display: "none" }}
            onChange={(ereignis) => {
              void verarbeite(Array.from(ereignis.target.files ?? []));
              ereignis.target.value = "";
            }}
          />
          <div>
            Dateien hierher ziehen oder <b>auswaehlen</b>
          </div>
          <div className="ablage-hinweis">{texte.grenze}</div>
        </label>

        {vorgaenge.length > 0 && (
          <ul className="warteschlange">
            {vorgaenge.map((vorgang) => (
              <li key={vorgang.key}>
                <span>{vorgang.filename}</span>
                <span className={vorgang.fehler ? "status-fehler" : "status-laeuft"}>
                  {vorgang.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="karte">
        <h2 className="karte-titel">
          Bestand{" "}
          <span className="karte-zusatz">
            {offen ? "· wird verarbeitet …" : `· ${liste.length} Dokumente`}
          </span>
        </h2>

        {liste.length === 0 ? (
          <p className="hinweis-text" style={{ margin: 0 }}>
            {texte.leer}
          </p>
        ) : (
          <div className="tabelle-huelle">
            <table>
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th>Zustand</th>
                  <th className="zahl">Groesse</th>
                  <th className="zahl">Seiten</th>
                  <th className="zahl">{einheit}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {liste.map((dokument) => (
                  <tr key={dokument.id}>
                    <td>
                      <a href={`/api/documents/${dokument.id}/download`}>
                        {dokument.filename}
                      </a>
                    </td>
                    <td>
                      <Zustand dokument={dokument} fertig={texte.fertig} />
                    </td>
                    <td className="zahl">{groesse(dokument.sizeBytes)}</td>
                    <td className="zahl">{dokument.pageCount || "—"}</td>
                    <td className="zahl">{dokument.chunkCount || "—"}</td>
                    <td className="zahl">
                      {dokument.status === "fehler" && (
                        <>
                          <button
                            className="knopf-schlicht"
                            onClick={() => void wiederhole(dokument)}
                          >
                            Erneut
                          </button>{" "}
                        </>
                      )}
                      <button
                        className="knopf-schlicht"
                        onClick={() => void loescheDokument(dokument)}
                      >
                        Entfernen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="karte gefahr">
        <h2 className="karte-titel">Sammlung loeschen</h2>
        <p className="hinweis-text">
          Entfernt <b>unwiderruflich</b> {texte.loeschen}. Das laesst sich nicht
          rueckgaengig machen — zum Bestaetigen bitte <b>{BESTAETIGUNG}</b> eintippen.
        </p>

        <div className="feld" style={{ maxWidth: 260 }}>
          <label htmlFor="bestaetigung">Bestaetigung</label>
          <input
            id="bestaetigung"
            type="text"
            value={bestaetigung}
            placeholder={BESTAETIGUNG}
            autoComplete="off"
            onChange={(ereignis) => setBestaetigung(ereignis.target.value)}
          />
        </div>

        <button
          className="knopf"
          disabled={bestaetigung !== BESTAETIGUNG || loeschtSammlung}
          onClick={() => void loescheSammlung()}
        >
          {loeschtSammlung ? "Wird geloescht …" : "Sammlung unwiderruflich loeschen"}
        </button>
      </div>

      {dialog}
    </>
  );
}

// --- Teilstuecke ------------------------------------------------------------

function Zustand({ dokument, fertig }: { dokument: DocumentRecord; fertig: string }) {
  if (dokument.status === "fertig") {
    return <span className="status-fertig">{fertig}</span>;
  }

  if (dokument.status === "fehler") {
    return (
      <span className="status-fehler" title={dokument.error ?? undefined}>
        {dokument.error ?? "Fehlgeschlagen"}
      </span>
    );
  }

  return (
    <span className="status-laeuft">
      {dokument.status === "wartet" ? "Wartet" : "Wird ausgewertet …"}
    </span>
  );
}

/**
 * Formular fuer Name und Beschreibung. Speichern uebernimmt der Aufrufer —
 * er schliesst das Formular sofort und zeigt die Werte optimistisch an.
 */
function Angaben({
  name: anfangsName,
  beschreibung: anfangsBeschreibung,
  onSpeichern,
  onAbbrechen,
}: {
  name: string;
  beschreibung: string;
  onSpeichern: (name: string, beschreibung: string) => void;
  onAbbrechen: () => void;
}) {
  const [name, setName] = useState(anfangsName);
  const [beschreibung, setBeschreibung] = useState(anfangsBeschreibung);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="feld">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={name}
          maxLength={80}
          onChange={(ereignis) => setName(ereignis.target.value)}
        />
      </div>

      <div className="feld">
        <label htmlFor="beschreibung">
          Beschreibung{" "}
          <span className="feld-zusatz">
            Der Assistent entscheidet daran, wann er in dieser Sammlung sucht.
          </span>
        </label>
        <textarea
          id="beschreibung"
          value={beschreibung}
          rows={2}
          maxLength={400}
          onChange={(ereignis) => setBeschreibung(ereignis.target.value)}
        />
      </div>

      <div className="knopfzeile">
        <button
          className="knopf"
          disabled={name.trim().length === 0}
          onClick={() => onSpeichern(name, beschreibung)}
        >
          Speichern
        </button>
        <button className="knopf knopf-sekundaer" onClick={onAbbrechen}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

function schwelle(minScore: number): string {
  return minScore.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function groesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
