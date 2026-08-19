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
                // <details> statt eigenem State: der Browser uebernimmt das Auf- und
                // Zuklappen samt Tastaturbedienung. Der Zustand liegt im DOM, ein
                // aufgeklappter Block bleibt also offen, waehrend weiter unten eine
                // neue Antwort hereinstreamt.
                <details className="quellen">
                  <summary>
                    <span className="quellen-anzahl">
                      Fundstellen ({nachricht.sources.length})
                    </span>
                    <span className="quellen-dateien">{dateiliste(nachricht.sources)}</span>
                  </summary>
                  <ol>
                    {nachricht.sources.map((quelle) => (
                      <li key={quelle.n}>
                        <b>
                          {quelle.filename}
                          {quelle.location ? `, ${quelle.location}` : ""}
                        </b>{" "}
                        &mdash; {quelle.snippet}
                        {quelle.snippet.length >= 240 ? "…" : ""}
                      </li>
                    ))}
                  </ol>
                </details>
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
 * Eindeutige Dateinamen der Fundstellen.
 *
 * Steht in der zugeklappten Kopfzeile und beantwortet damit die haeufigste
 * Frage — woher stammt das? — ohne dass man aufklappen muss. Mehrere Treffer
 * kommen oft aus derselben Datei, deshalb dedupliziert.
 */
function dateiliste(quellen: Quelle[]): string {
  return [...new Set(quellen.map((quelle) => quelle.filename))].join(", ");
}
