"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownText from "@/components/MarkdownText";
import type { Nachricht, Quelle } from "@/lib/chatVerlauf";
import type { ToolStep } from "@/lib/tools-types";

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
                <span className="tippt">
                  {nachricht.steps?.length
                    ? "Werte Abfragen aus …"
                    : "Recherchiere in den Dokumenten …"}
                </span>
              ) : null}

              {nachricht.steps && nachricht.steps.length > 0 && (
                <Abfragen steps={nachricht.steps} />
              )}

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

const WERKZEUG_LABEL: Record<ToolStep["tool"], string> = {
  dokumente_durchsuchen: "Suche",
  sql_ausfuehren: "SQL",
  cypher_ausfuehren: "Cypher",
};

const WERKZEUG_TYP: Record<ToolStep["tool"], string> = {
  dokumente_durchsuchen: "vector",
  sql_ausfuehren: "sql",
  cypher_ausfuehren: "graph",
};

/**
 * Die Werkzeugaufrufe einer Antwort: was das Modell abgefragt hat und was
 * zurueckkam.
 *
 * Steht zwischen Antwort und Fundstellen, weil es die Antwort erklaert: Bei
 * SQL und Cypher ist die Abfrage selbst der Beleg — wer der Zahl nicht traut,
 * liest die Abfrage und die ersten Zeilen des Ergebnisses. Ein einzelner
 * Schritt und jeder Fehler sind aufgeklappt; bei mehreren Schritten waere die
 * Blase sonst laenger als die Antwort.
 */
function Abfragen({ steps }: { steps: ToolStep[] }) {
  return (
    <div className="abfragen">
      <div className="abfragen-titel">Abfragen ({steps.length})</div>
      {steps.map((step, i) => (
        <details key={i} className="abfrage" open={steps.length === 1 || Boolean(step.error)}>
          <summary>
            <span className={`typ-marke typ-${WERKZEUG_TYP[step.tool]}`}>
              {WERKZEUG_LABEL[step.tool]}
            </span>
            <span className="abfrage-sammlung">{step.collectionName}</span>
            <span className="abfrage-meta">{schrittStatus(step)}</span>
          </summary>
          <pre className="abfrage-text">{step.query}</pre>
          {step.error && <div className="abfrage-fehler">{step.error}</div>}
          {!step.error && step.tool !== "dokumente_durchsuchen" && (
            <Vorschau columns={step.columns ?? []} rows={step.preview ?? []} />
          )}
        </details>
      ))}
    </div>
  );
}

function schrittStatus(step: ToolStep): string {
  if (step.error) return "Fehler";
  if (step.rowCount === undefined) return "";

  const einheit = step.tool === "dokumente_durchsuchen" ? "Treffer" : "Zeilen";
  return `${step.rowCount} ${einheit}${step.truncated ? " (gekuerzt)" : ""}`;
}

/**
 * Ergebnisvorschau fuer SQL (Zeilen als Arrays) und Cypher (Zeilen als
 * Objekte, Spaltennamen als Schluessel).
 */
function Vorschau({ columns, rows }: { columns: string[]; rows: unknown[] }) {
  if (rows.length === 0) return <div className="abfrage-leer">Kein Ergebnis.</div>;

  const zellen = (row: unknown): unknown[] =>
    Array.isArray(row) ? row : columns.map((column) => (row as Record<string, unknown>)[column]);

  return (
    <div className="tabelle-huelle">
      <table className="vorschau">
        {columns.length > 0 && (
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {zellen(row).map((zelle, j) => (
                <td key={j}>{zelleAlsText(zelle)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Knoten und Kanten aus Cypher-Ergebnissen kompakt, alles andere woertlich. */
function zelleAlsText(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const record = value as {
    type?: string;
    labels?: string[];
    relationshipType?: string;
    properties?: Record<string, unknown>;
  };
  if (record.type === "node") {
    return `(${(record.labels ?? []).join(":")} ${kurzJson(record.properties)})`;
  }
  if (record.type === "edge") {
    return `-[:${record.relationshipType} ${kurzJson(record.properties)}]-`;
  }
  return kurzJson(value);
}

function kurzJson(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
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
