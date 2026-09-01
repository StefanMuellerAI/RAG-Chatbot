"use client";

import { upload } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { formatiereDatum, formatiereGroesse } from "@/lib/format";

type Dokument = {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  chunkCount: number;
};

type Vorgang = {
  key: string;
  filename: string;
  status: "laeuft" | "fertig" | "fehler";
  text: string;
};

const ERLAUBTE_ENDUNGEN = [".pdf", ".docx", ".xlsx"];

/** Dokumente einer einzelnen Sammlung: hochladen, auflisten, loeschen. */
export default function DocumentsPanel({
  collectionId,
  collectionName,
  dokumente,
}: {
  collectionId: string;
  collectionName: string;
  dokumente: Dokument[];
}) {
  const router = useRouter();
  const [aktualisiert, aktualisiere] = useTransition();
  const [fehler, setFehler] = useState<string | null>(null);
  const [vorgaenge, setVorgaenge] = useState<Vorgang[]>([]);
  const [ueberAblage, setUeberAblage] = useState(false);
  const vorgangZaehler = useRef(0);

  /** Laedt die serverseitig gerenderte Liste neu. */
  function aktualisiereListe() {
    aktualisiere(() => router.refresh());
  }

  async function verarbeite(dateien: File[]) {
    let verarbeitet = 0;
    let abgemeldet = false;

    for (const datei of dateien) {
      // Laufende Nummer, damit dieselbe Datei mehrfach hintereinander einen
      // eigenen Eintrag bekommt statt den vorigen zu ueberschreiben.
      const key = `${++vorgangZaehler.current}-${datei.name}`;

      if (abgemeldet) {
        setzeVorgang({ key, filename: datei.name, status: "fehler", text: "Abgebrochen: nicht angemeldet" });
        continue;
      }

      if (!ERLAUBTE_ENDUNGEN.some((endung) => datei.name.toLowerCase().endsWith(endung))) {
        setzeVorgang({
          key,
          filename: datei.name,
          status: "fehler",
          text: "Format nicht unterstützt (nur PDF, DOCX, XLSX)",
        });
        continue;
      }

      setzeVorgang({ key, filename: datei.name, status: "laeuft", text: "Wird hochgeladen …" });

      try {
        // Schritt 1: direkt vom Browser in den Blob-Store — so greift das
        // 4,5-MB-Limit fuer Request-Bodies von Serverless-Funktionen nicht.
        const blob = await upload(`files/${collectionId}/${crypto.randomUUID()}/${datei.name}`, datei, {
          access: "private",
          handleUploadUrl: "/api/upload",
          contentType: datei.type || undefined,
          clientPayload: JSON.stringify({ collectionId }),
        });

        setzeVorgang({ key, filename: datei.name, status: "laeuft", text: "Wird ausgewertet …" });

        // Schritt 2: Text extrahieren und in die Vektor-Datenbank schreiben.
        const antwort = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blobPath: blob.pathname,
            filename: datei.name,
            contentType: datei.type,
            collectionId,
          }),
        });

        if (antwort.status === 401) {
          abgemeldet = true;
          setzeVorgang({ key, filename: datei.name, status: "fehler", text: "Abgebrochen: nicht angemeldet" });
          continue;
        }

        const daten = await antwort.json();
        if (!antwort.ok) throw new Error(daten.error ?? "Verarbeitung fehlgeschlagen.");

        verarbeitet++;
        setzeVorgang({
          key,
          filename: datei.name,
          status: "fertig",
          text: `Fertig · ${daten.document.chunkCount} Abschnitte`,
        });
      } catch (error) {
        setzeVorgang({
          key,
          filename: datei.name,
          status: "fehler",
          text: error instanceof Error ? error.message : "Unbekannter Fehler.",
        });
      }
    }

    // Einmal am Ende statt nach jeder Datei — jeder Refresh laedt die Liste neu.
    if (verarbeitet > 0) aktualisiereListe();
    if (abgemeldet) router.push(`/login?weiter=/sammlungen`);
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

  async function loesche(dokument: Dokument) {
    if (!window.confirm(`"${dokument.filename}" wirklich aus „${collectionName}" entfernen?`)) return;
    setFehler(null);

    try {
      const antwort = await fetch(`/api/documents/${dokument.id}`, { method: "DELETE" });
      if (antwort.status === 401) return void router.push("/login?weiter=/sammlungen");

      const daten = await antwort.json();
      if (!antwort.ok) throw new Error(daten.error ?? "Löschen fehlgeschlagen.");
      aktualisiereListe();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    }
  }

  const abschnitteGesamt = dokumente.reduce((summe, dokument) => summe + dokument.chunkCount, 0);

  return (
    <>
      {fehler && <div className="meldung">{fehler}</div>}

      <div className="karte">
        <h2 className="karte-titel">Dokumente einpflegen · {collectionName}</h2>
        <p className="hinweis-text">
          PDF, DOCX und XLSX. Der Text wird ausgelesen, in Abschnitte zerlegt und in die
          Vektor-Datenbank geschrieben. Ab dann ist er im Chat dieser Sammlung auffindbar.
        </p>

        <label
          className={ueberAblage ? "ablage aktiv" : "ablage"}
          onDragOver={(event) => {
            event.preventDefault();
            setUeberAblage(true);
          }}
          onDragLeave={() => setUeberAblage(false)}
          onDrop={(event) => {
            event.preventDefault();
            setUeberAblage(false);
            void verarbeite(Array.from(event.dataTransfer.files));
          }}
        >
          <input
            type="file"
            multiple
            accept={ERLAUBTE_ENDUNGEN.join(",")}
            style={{ display: "none" }}
            onChange={(event) => {
              void verarbeite(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <div>
            Dateien hierher ziehen oder <b>auswählen</b>
          </div>
          <div className="ablage-hinweis">
            Mehrere Dateien gleichzeitig möglich · max. 100 MB je Datei
          </div>
        </label>

        {vorgaenge.length > 0 && (
          <ul className="warteschlange">
            {vorgaenge.map((vorgang) => (
              <li key={vorgang.key}>
                <span>{vorgang.filename}</span>
                <span className={`status-${vorgang.status}`}>{vorgang.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="karte">
        <h2 className="karte-titel">
          Inhalt{" "}
          <span style={{ fontWeight: 400, color: "var(--grau-600)", fontSize: 15 }}>
            · {dokumente.length} {dokumente.length === 1 ? "Dokument" : "Dokumente"} ·{" "}
            {abschnitteGesamt} Abschnitte
            {aktualisiert ? " · wird aktualisiert …" : ""}
          </span>
        </h2>

        {dokumente.length === 0 ? (
          <p className="hinweis-text">
            Noch nichts eingepflegt. Der Chat kann in dieser Sammlung derzeit keine Fragen beantworten.
          </p>
        ) : (
          <div className="tabelle-huelle">
            <table>
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th className="zahl">Größe</th>
                  <th className="zahl">Abschnitte</th>
                  <th className="zahl">Hinzugefügt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dokumente.map((dokument) => (
                  <tr key={dokument.id}>
                    <td>
                      <a href={`/api/documents/${dokument.id}/download`}>{dokument.filename}</a>
                    </td>
                    <td className="zahl">{formatiereGroesse(dokument.size)}</td>
                    <td className="zahl">{dokument.chunkCount}</td>
                    <td className="zahl">{formatiereDatum(dokument.uploadedAt)}</td>
                    <td className="zahl">
                      <button className="knopf-schlicht" onClick={() => void loesche(dokument)}>
                        Löschen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
