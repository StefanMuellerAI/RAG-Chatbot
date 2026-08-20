"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownText from "@/components/MarkdownText";
import type { Nachricht, Quelle } from "@/lib/chatVerlauf";

type Eigenschaften = {
  nachrichten: Nachricht[];
  laeuft: boolean;
  onSenden: (frage: string) => void;
};

/**
 * Reine Darstellung des Gespraechs. Verlauf und Streaming liegen bei
 * `ChatBereich` — diese Komponente zeigt nur, was sie bekommt.
 */
export default function ChatPanel({ nachrichten, laeuft, onSenden }: Eigenschaften) {
  const [eingabe, setEingabe] = useState("");
  const endeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endeRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [nachrichten, laeuft]);

  function absenden() {
    const frage = eingabe.trim();
    if (!frage || laeuft) return;

    setEingabe("");
    onSenden(frage);
  }

  const letzte = nachrichten[nachrichten.length - 1];
  const wartetAufErstesWort = laeuft && (!letzte || letzte.role === "user" || !letzte.content);

  return (
    <div className="karte">
      <div className="chat">
        <div className="chat-verlauf" aria-live="polite">
          {nachrichten.length === 0 && (
            <div className="chat-leer">
              <h2>Was moechten Sie wissen?</h2>
              <p>
                Fragen Sie etwas zu den eingepflegten Dokumenten. Jede Antwort nennt die
                Fundstellen, auf die sie sich stuetzt.
              </p>
            </div>
          )}

          {nachrichten.map((nachricht, i) => (
            <div
              key={i}
              className={
                nachricht.fehler
                  ? "blase blase-fehler"
                  : nachricht.role === "user"
                    ? "blase blase-nutzer"
                    : "blase blase-assistent"
              }
            >
              {/* Nur Antworten werden als Markdown gerendert. Was jemand selbst
                  eintippt, bleibt woertlich stehen — wer *Sternchen* schreibt,
                  will Sternchen sehen. Fehlermeldungen ebenso. */}
              {nachricht.content ? (
                nachricht.role === "assistant" && !nachricht.fehler ? (
                  <MarkdownText text={nachricht.content} />
                ) : (
                  nachricht.content
                )
              ) : i === nachrichten.length - 1 && laeuft ? (
                <span className="tippt">Recherchiere in den Dokumenten &hellip;</span>
              ) : null}

              {nachricht.sources && nachricht.sources.length > 0 && nachricht.content && (
                <Fundstellen quellen={nachricht.sources} />
              )}
            </div>
          ))}

          {wartetAufErstesWort && letzte?.role === "user" && (
            <div className="blase blase-assistent">
              <span className="tippt">Recherchiere in den Dokumenten &hellip;</span>
            </div>
          )}

          <div ref={endeRef} />
        </div>

        <div className="chat-eingabe">
          <textarea
            value={eingabe}
            onChange={(event) => setEingabe(event.target.value)}
            onKeyDown={(event) => {
              // Enter sendet, Umschalt+Enter macht einen Zeilenumbruch.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                absenden();
              }
            }}
            placeholder="Ihre Frage &hellip;"
            rows={2}
            aria-label="Ihre Frage"
            disabled={laeuft}
          />
          <button className="knopf" onClick={absenden} disabled={laeuft || !eingabe.trim()}>
            {laeuft ? "Antwortet …" : "Senden"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Die Fundstellen unter einer Antwort.
 *
 * `<details>` statt eigenem State: der Browser uebernimmt das Auf- und
 * Zuklappen samt Tastaturbedienung. Der Zustand liegt im DOM, ein aufgeklappter
 * Block bleibt also offen, waehrend weiter unten eine neue Antwort hereinstreamt.
 */
function Fundstellen({ quellen }: { quellen: Quelle[] }) {
  // Einmal berechnet statt je Zeile: Bei zwoelf Fundstellen waere es sonst
  // zwoelfmal dieselbe Auswertung derselben Liste.
  const mehrere = mehrereSammlungen(quellen);

  return (
    <details className="quellen">
      <summary>
        <span className="quellen-anzahl">Fundstellen ({quellen.length})</span>
        <span className="quellen-dateien">{herkunft(quellen)}</span>
      </summary>
      <ol>
        {quellen.map((quelle) => (
          <li key={quelle.n}>
            <b>
              {quelle.filename}
              {quelle.location ? `, ${quelle.location}` : ""}
            </b>
            {/* Die Sammlung nur nennen, wenn die Antwort aus mehreren stammt.
                Bei einer einzigen waere sie in jeder Zeile dieselbe Angabe und
                damit nur Rauschen. */}
            {mehrere && quelle.collectionName && (
              <span className="quellen-sammlung">{quelle.collectionName}</span>
            )}{" "}
            &mdash; {quelle.snippet}
            {quelle.snippet.length >= 240 ? "…" : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}

function eindeutig(werte: (string | undefined)[]): string[] {
  return [...new Set(werte.filter((wert): wert is string => Boolean(wert)))];
}

function mehrereSammlungen(quellen: Quelle[]): boolean {
  return eindeutig(quellen.map((quelle) => quelle.collectionName)).length > 1;
}

/**
 * Herkunft der Fundstellen fuer die zugeklappte Kopfzeile.
 *
 * Sie beantwortet die haeufigste Frage — woher stammt das? — ohne dass man
 * aufklappen muss. Bei mehreren Sammlungen sind deren Namen die Antwort darauf:
 * Der Assistent hat sich selbst fuer sie entschieden, und das soll nachvollziehbar
 * sein, ohne die Liste zu oeffnen. Bei einer einzigen Sammlung ist ihr Name
 * bekannt, und die Dateinamen sind das Interessantere.
 */
function herkunft(quellen: Quelle[]): string {
  const sammlungen = eindeutig(quellen.map((quelle) => quelle.collectionName));
  if (sammlungen.length > 1) return sammlungen.join(" · ");

  return eindeutig(quellen.map((quelle) => quelle.filename)).join(", ");
}
