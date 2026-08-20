"use client";

import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SammlungMitKlasse } from "@/lib/collections";
import type { DocumentRecord } from "@/lib/db/schema";
import type { Preset } from "@/lib/presets";

/**
 * Eine Sammlung: Dokumente einpflegen, Fortschritt verfolgen, entfernen.
 *
 * Die Verarbeitung laeuft nicht mehr innerhalb des Upload-Requests, sondern als
 * eigener Ablauf auf dem Server. Diese Ansicht fragt deshalb den Zustand ab,
 * statt auf eine Antwort zu warten — ein Dokument mit hunderten Seiten braucht
 * laenger, als ein Browser sinnvoll wartet.
 */

const ERLAUBTE_ENDUNGEN = [".pdf", ".docx", ".xlsx"];
const BESTAETIGUNG = "LÖSCHEN";
/** Abfrageabstand, solange etwas laeuft. */
const ABFRAGE_MS = 2_500;

type Eigenschaften = {
  sammlung: SammlungMitKlasse;
  dokumente: DocumentRecord[];
  preset: Preset;
};

type Vorgang = { key: string; filename: string; text: string; fehler: boolean };

export default function SammlungDetail({ sammlung, dokumente, preset }: Eigenschaften) {
  const router = useRouter();

  const [liste, setListe] = useState(dokumente);
  const [vorgaenge, setVorgaenge] = useState<Vorgang[]>([]);
  const [ueberAblage, setUeberAblage] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [bestaetigung, setBestaetigung] = useState("");
  const [loeschtSammlung, setLoeschtSammlung] = useState(false);
  const [bearbeitet, setBearbeitet] = useState(false);

  const laufendeAbfrage = useRef(false);

  const offen = liste.some(
    (dokument) => dokument.status === "wartet" || dokument.status === "laeuft",
  );

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

      if (!ERLAUBTE_ENDUNGEN.some((endung) => datei.name.toLowerCase().endsWith(endung))) {
        setzeVorgang({
          key,
          filename: datei.name,
          text: "Format nicht unterstuetzt (nur PDF, DOCX, XLSX)",
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

        setzeVorgang({ key, filename: datei.name, text: "Wird hochgeladen …", fehler: false });

        // Schritt 2: direkt vom Browser in den Blob-Store — so greift das
        // 4,5-MB-Limit fuer Request-Bodies von Serverless-Funktionen nicht.
        await upload(angemeldet.blobPfad, datei, {
          access: "private",
          handleUploadUrl: "/api/upload",
          contentType: datei.type || undefined,
        });

        // Schritt 3: Verarbeitung anstossen. Kommt sofort zurueck.
        const angestossen = await fetch(
          `/api/documents/${angemeldet.dokument.id}/verarbeiten`,
          { method: "POST" },
        );

        if (!angestossen.ok) {
          const daten = await angestossen.json().catch(() => ({}));
          throw new Error(daten.error ?? `Status ${angestossen.status}`);
        }

        setzeVorgang({
          key,
          filename: datei.name,
          text: "In der Verarbeitung",
          fehler: false,
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
    if (!window.confirm(`"${dokument.filename}" aus der Sammlung entfernen?`)) return;
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
        <Link href="/sammlungen">Sammlungen</Link> · {sammlung.name}
      </p>

      <div className="karte">
        <h1 className="karte-titel">
          {sammlung.name} <span className="marke">{klasse.id}</span>
        </h1>

        {bearbeitet ? (
          <Angaben
            sammlung={sammlung}
            onFertig={() => {
              setBearbeitet(false);
              router.refresh();
            }}
            onFehler={setFehler}
          />
        ) : (
          <>
            <p className="hinweis-text" style={{ marginBottom: 10 }}>
              {sammlung.description || "Keine Beschreibung hinterlegt."}
            </p>
            <button className="knopf-schlicht" onClick={() => setBearbeitet(true)}>
              Name und Beschreibung aendern
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
            <div className="kennzahl-beschriftung">Abschnitte</div>
          </div>
          <div className="kennzahl">
            <div className="kennzahl-wert" style={{ fontSize: 17 }}>
              {preset.label}
            </div>
            <div className="kennzahl-beschriftung">Verarbeitung</div>
          </div>
        </div>
      </div>

      <div className="karte">
        <h2 className="karte-titel">Dokumente einpflegen</h2>
        <p className="hinweis-text">
          PDF, DOCX und XLSX. {preset.kurz} Hoechstens {klasse.maxPagesPerDocument} Seiten
          und {Math.round(klasse.maxFileBytes / (1024 * 1024))} MB je Datei.
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
            accept={ERLAUBTE_ENDUNGEN.join(",")}
            style={{ display: "none" }}
            onChange={(ereignis) => {
              void verarbeite(Array.from(ereignis.target.files ?? []));
              ereignis.target.value = "";
            }}
          />
          <div>
            Dateien hierher ziehen oder <b>auswaehlen</b>
          </div>
          <div className="ablage-hinweis">Mehrere Dateien gleichzeitig moeglich</div>
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
            Noch nichts eingepflegt. Zu dieser Sammlung kann der Chat derzeit nichts sagen.
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
                  <th className="zahl">Abschnitte</th>
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
                      <Zustand dokument={dokument} />
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
          Entfernt <b>alle</b> Dokumente dieser Sammlung, alle Abschnitte und alle
          Originaldateien. Das laesst sich nicht rueckgaengig machen — zum Bestaetigen bitte{" "}
          <b>{BESTAETIGUNG}</b> eintippen.
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
    </>
  );
}

// --- Teilstuecke ------------------------------------------------------------

function Zustand({ dokument }: { dokument: DocumentRecord }) {
  if (dokument.status === "fertig") {
    return <span className="status-fertig">Durchsuchbar</span>;
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

function Angaben({
  sammlung,
  onFertig,
  onFehler,
}: {
  sammlung: SammlungMitKlasse;
  onFertig: () => void;
  onFehler: (meldung: string) => void;
}) {
  const [name, setName] = useState(sammlung.name);
  const [beschreibung, setBeschreibung] = useState(sammlung.description);
  const [speichert, setSpeichert] = useState(false);

  async function speichere() {
    setSpeichert(true);

    try {
      const antwort = await fetch(`/api/collections/${sammlung.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, beschreibung }),
      });

      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? `Status ${antwort.status}`);

      onFertig();
    } catch (error) {
      onFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setSpeichert(false);
    }
  }

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
        <button className="knopf" disabled={speichert} onClick={() => void speichere()}>
          Speichern
        </button>
        <button className="knopf knopf-sekundaer" onClick={onFertig}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

function groesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
