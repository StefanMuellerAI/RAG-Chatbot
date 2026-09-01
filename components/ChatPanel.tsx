"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KIND_LABEL, type CollectionKind } from "@/lib/collection-kinds";
import type { ToolStep } from "@/lib/tools";

export type ChatSammlung = { id: string; name: string; kind: CollectionKind };

/** Kennung fuer "Alle meine Sammlungen" — muss zur Chat-Route passen. */
export const ALLE_SAMMLUNGEN = "all";

type Quelle = {
  n: number;
  filename: string;
  location: string | null;
  score: number;
  snippet: string;
};

type Nachricht = {
  role: "user" | "assistant";
  content: string;
  sources?: Quelle[];
  /** Werkzeugaufrufe (Suche, SQL, Cypher), die zu dieser Antwort gefuehrt haben. */
  steps?: ToolStep[];
  fehler?: boolean;
};

type Ereignis =
  | { type: "sources"; sources: Quelle[] }
  | { type: "step"; step: ToolStep }
  | { type: "text"; delta: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** Ab so vielen Pixeln Abstand zum Seitenende gilt der Nutzer als "hochgescrollt". */
const SCROLL_TOLERANZ = 120;

/**
 * Zuletzt gewaehlte Sammlung — pro Browser in localStorage gemerkt und als
 * externer Speicher an React angebunden. Auf dem Server gibt es keine Auswahl,
 * deshalb liefert der Server-Schnappschuss `null`.
 */
const SPEICHER_SCHLUESSEL = "rag.sammlung";
const zuhoerer = new Set<() => void>();

function abonniereAuswahl(benachrichtige: () => void): () => void {
  zuhoerer.add(benachrichtige);
  window.addEventListener("storage", benachrichtige);
  return () => {
    zuhoerer.delete(benachrichtige);
    window.removeEventListener("storage", benachrichtige);
  };
}

function leseAuswahl(): string | null {
  return window.localStorage.getItem(SPEICHER_SCHLUESSEL);
}

function merkeAuswahl(id: string): void {
  window.localStorage.setItem(SPEICHER_SCHLUESSEL, id);
  zuhoerer.forEach((benachrichtige) => benachrichtige());
}

export default function ChatPanel({ sammlungen }: { sammlungen: ChatSammlung[] }) {
  const [verlauf, setVerlauf] = useState<Nachricht[]>([]);
  const [eingabe, setEingabe] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const endeRef = useRef<HTMLDivElement>(null);
  const nutzerIstUnten = useRef(true);

  const gemerkt = useSyncExternalStore(abonniereAuswahl, leseAuswahl, () => null);
  const alleErlaubt = sammlungen.length > 1;
  const gemerktGueltig =
    gemerkt !== null &&
    ((gemerkt === ALLE_SAMMLUNGEN && alleErlaubt) || sammlungen.some((sammlung) => sammlung.id === gemerkt));
  const sammlungId = gemerktGueltig ? gemerkt : (sammlungen[0]?.id ?? "");

  function wechsleSammlung(id: string) {
    merkeAuswahl(id);
    // Ein neuer Kontext — der alte Verlauf bezog sich auf andere Dokumente.
    setVerlauf([]);
  }

  // Text-Deltas kommen im Stream schneller als der Browser rendern kann.
  // Sie werden gesammelt und einmal pro Frame in den Verlauf geschrieben.
  const ausstehenderText = useRef("");
  const frameId = useRef<number | null>(null);

  useEffect(() => {
    const beobachte = () => {
      const abstand = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      nutzerIstUnten.current = abstand < SCROLL_TOLERANZ;
    };
    window.addEventListener("scroll", beobachte, { passive: true });
    return () => window.removeEventListener("scroll", beobachte);
  }, []);

  useEffect(() => {
    if (nutzerIstUnten.current) {
      endeRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [verlauf, laeuft]);

  const aendereLetzteAntwort = useCallback((aenderung: (letzte: Nachricht) => Nachricht) => {
    setVerlauf((bisher) => {
      const letzte = bisher[bisher.length - 1];
      if (!letzte || letzte.role !== "assistant") return bisher;
      return [...bisher.slice(0, -1), aenderung(letzte)];
    });
  }, []);

  const schreibeAusstehendenText = useCallback(() => {
    if (frameId.current !== null) {
      cancelAnimationFrame(frameId.current);
      frameId.current = null;
    }
    const text = ausstehenderText.current;
    ausstehenderText.current = "";
    if (text) aendereLetzteAntwort((letzte) => ({ ...letzte, content: letzte.content + text }));
  }, [aendereLetzteAntwort]);

  function verarbeite(ereignis: Ereignis) {
    switch (ereignis.type) {
      case "sources":
        aendereLetzteAntwort((letzte) => ({ ...letzte, sources: ereignis.sources }));
        break;
      case "step":
        // Werkzeugaufruf sofort zeigen — der Nutzer sieht, was die KI gerade abfragt.
        schreibeAusstehendenText();
        aendereLetzteAntwort((letzte) => ({ ...letzte, steps: [...(letzte.steps ?? []), ereignis.step] }));
        break;
      case "text":
        ausstehenderText.current += ereignis.delta;
        if (frameId.current === null) {
          frameId.current = requestAnimationFrame(schreibeAusstehendenText);
        }
        break;
      case "error":
        schreibeAusstehendenText();
        aendereLetzteAntwort((letzte) => ({
          ...letzte,
          // Bereits gestreamter Text bleibt stehen, der Grund kommt darunter.
          content: letzte.content
            ? `${letzte.content}\n\n[Abgebrochen: ${ereignis.message}]`
            : ereignis.message,
          fehler: true,
        }));
        break;
      case "done":
        schreibeAusstehendenText();
        break;
    }
  }

  async function absenden() {
    const frage = eingabe.trim();
    if (!frage || laeuft || !sammlungId) return;

    // Der Verlauf fuer die API enthaelt nur echte Konversation — Fehlermeldungen
    // aus frueheren Versuchen wuerden das Modell nur verwirren.
    const gesendet: Nachricht[] = [...verlauf, { role: "user", content: frage }];
    setVerlauf(gesendet);
    setEingabe("");
    setLaeuft(true);
    nutzerIstUnten.current = true;

    try {
      const antwort = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionId: sammlungId,
          messages: gesendet
            .filter((n) => !n.fehler)
            .map((n) => ({ role: n.role, content: n.content })),
        }),
      });

      if (!antwort.ok || !antwort.body) {
        const daten = await antwort.json().catch(() => ({}));
        throw new Error(daten.error ?? `Der Server antwortete mit Status ${antwort.status}.`);
      }

      setVerlauf((bisher) => [...bisher, { role: "assistant", content: "" }]);

      const leser = antwort.body.getReader();
      const decoder = new TextDecoder();
      let puffer = "";

      const verarbeiteZeile = (zeile: string) => {
        if (!zeile.trim()) return;
        try {
          verarbeite(JSON.parse(zeile) as Ereignis);
        } catch {
          // Eine einzelne unlesbare Zeile soll nicht die ganze Antwort kippen.
        }
      };

      for (;;) {
        const { done, value } = await leser.read();
        if (done) break;

        puffer += decoder.decode(value, { stream: true });
        const zeilen = puffer.split("\n");
        // Die letzte Zeile kann abgeschnitten sein und wartet auf den naechsten Happen.
        puffer = zeilen.pop() ?? "";
        zeilen.forEach(verarbeiteZeile);
      }

      puffer += decoder.decode();
      verarbeiteZeile(puffer);
      schreibeAusstehendenText();
    } catch (error) {
      schreibeAusstehendenText();
      const meldung = error instanceof Error ? error.message : "Unbekannter Fehler.";
      setVerlauf((bisher) => {
        const letzte = bisher[bisher.length - 1];
        // Ist die Antwortblase schon da, wird sie zum Fehler — keine zweite Blase.
        if (letzte?.role === "assistant") {
          return [
            ...bisher.slice(0, -1),
            {
              ...letzte,
              content: letzte.content ? `${letzte.content}\n\n[Abgebrochen: ${meldung}]` : meldung,
              fehler: true,
            },
          ];
        }
        return [...bisher, { role: "assistant", content: meldung, fehler: true }];
      });
    } finally {
      setLaeuft(false);
    }
  }

  const letzte = verlauf[verlauf.length - 1];
  const wartetAufErstesWort = laeuft && (!letzte || letzte.role === "user" || !letzte.content);
  const alleModus = sammlungId === ALLE_SAMMLUNGEN;
  const aktiveSammlung = sammlungen.find((sammlung) => sammlung.id === sammlungId);

  if (sammlungen.length === 0) {
    return (
      <div className="karte">
        <div className="chat-leer">
          <h2>Noch keine Sammlung</h2>
          <p>
            Der Chat beantwortet Fragen zu Ihren eigenen Sammlungen — Dokumente, Tabellen oder
            Graphen. Legen Sie zuerst unter <Link href="/sammlungen">Sammlungen</Link> eine an
            und laden Sie Inhalte hoch.
          </p>
        </div>
      </div>
    );
  }

  const leerText = alleModus
    ? "Die KI entscheidet selbst, welche Ihrer Sammlungen sie befragt — per Suche, SQL oder Cypher. Unter jeder Antwort sehen Sie die ausgefuehrten Abfragen."
    : aktiveSammlung?.kind === "sql"
      ? `Fragen Sie etwas zu den Tabellen in „${aktiveSammlung.name}“. Die KI formuliert SQL und zeigt es unter der Antwort.`
      : aktiveSammlung?.kind === "graph"
        ? `Fragen Sie etwas zum Graphen „${aktiveSammlung.name}“. Die KI formuliert Cypher und zeigt es unter der Antwort.`
        : `Fragen Sie etwas zu den Dokumenten in „${aktiveSammlung?.name ?? "dieser Sammlung"}“. Jede Antwort nennt die Fundstellen, auf die sie sich stuetzt.`;

  return (
    <div className="karte">
      <div className="chat">
        <div className="chat-kopf">
          <label htmlFor="sammlung">Sammlung</label>
          <select
            id="sammlung"
            value={sammlungId}
            onChange={(event) => wechsleSammlung(event.target.value)}
            disabled={laeuft}
          >
            {alleErlaubt && <option value={ALLE_SAMMLUNGEN}>Alle meine Sammlungen (KI waehlt)</option>}
            {sammlungen.map((sammlung) => (
              <option key={sammlung.id} value={sammlung.id}>
                {sammlung.name} · {KIND_LABEL[sammlung.kind]}
              </option>
            ))}
          </select>
        </div>

        <div className="chat-verlauf" aria-live="polite">
          {verlauf.length === 0 && (
            <div className="chat-leer">
              <h2>Was moechten Sie wissen?</h2>
              <p>{leerText}</p>
            </div>
          )}

          {verlauf.map((nachricht, i) => (
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
              {nachricht.content ||
                (i === verlauf.length - 1 && laeuft ? (
                  <span className="tippt">
                    {nachricht.steps?.length ? "Werte Abfragen aus …" : "Recherchiere in den Sammlungen …"}
                  </span>
                ) : null)}

              {nachricht.steps && nachricht.steps.length > 0 && <Abfragen steps={nachricht.steps} />}

              {nachricht.sources && nachricht.sources.length > 0 && nachricht.content && (
                <div className="quellen">
                  <div className="quellen-titel">Fundstellen</div>
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
                </div>
              )}
            </div>
          ))}

          {wartetAufErstesWort && verlauf[verlauf.length - 1]?.role === "user" && (
            <div className="blase blase-assistent">
              <span className="tippt">Recherchiere in den Sammlungen &hellip;</span>
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
                void absenden();
              }
            }}
            placeholder="Ihre Frage &hellip;"
            rows={2}
            aria-label="Ihre Frage"
            disabled={laeuft}
          />
          <button
            className="knopf"
            onClick={() => void absenden()}
            disabled={laeuft || !eingabe.trim() || !sammlungId}
          >
            {laeuft ? "Antwortet …" : "Senden"}
          </button>
        </div>
      </div>
    </div>
  );
}

const WERKZEUG_LABEL: Record<ToolStep["tool"], string> = {
  search_documents: "Suche",
  run_sql: "SQL",
  run_cypher: "Cypher",
};

/** Die Werkzeugaufrufe einer Antwort: was die KI abgefragt hat und was zurueckkam. */
function Abfragen({ steps }: { steps: ToolStep[] }) {
  return (
    <div className="abfragen">
      <div className="quellen-titel">Abfragen</div>
      {steps.map((step, i) => (
        <details key={i} className="abfrage" open={steps.length === 1 || Boolean(step.error)}>
          <summary>
            <span className={`typ-marke typ-${step.tool === "run_sql" ? "sql" : step.tool === "run_cypher" ? "graph" : "vector"}`}>
              {WERKZEUG_LABEL[step.tool]}
            </span>
            <span className="abfrage-sammlung">{step.collectionName}</span>
            <span className="schema-meta">
              {step.error
                ? "Fehler"
                : step.rowCount !== undefined
                  ? `${step.rowCount} ${step.tool === "search_documents" ? "Treffer" : "Zeilen"}${step.truncated ? " (gekuerzt)" : ""}`
                  : ""}
            </span>
          </summary>
          <pre className="abfrage-text">{step.query}</pre>
          {step.error && <div className="abfrage-fehler">{step.error}</div>}
          {!step.error && step.tool !== "search_documents" && <Vorschau columns={step.columns ?? []} rows={step.preview ?? []} />}
        </details>
      ))}
    </div>
  );
}

/** Ergebnisvorschau fuer SQL (Zeilen als Arrays) und Cypher (Zeilen als Objekte). */
function Vorschau({ columns, rows }: { columns: string[]; rows: unknown[] }) {
  if (rows.length === 0) return <div className="schema-meta">Kein Ergebnis.</div>;

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

function zelleAlsText(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = value as { type?: string; labels?: string[]; relationshipType?: string; properties?: Record<string, unknown> };
  if (record.type === "node") return `(${(record.labels ?? []).join(":")} ${kurzJson(record.properties)})`;
  if (record.type === "edge") return `-[:${record.relationshipType} ${kurzJson(record.properties)}]-`;
  return kurzJson(value);
}

function kurzJson(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
