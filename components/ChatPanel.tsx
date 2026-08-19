"use client";

import { useEffect, useRef, useState } from "react";

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
  fehler?: boolean;
};

export default function ChatPanel() {
  const [verlauf, setVerlauf] = useState<Nachricht[]>([]);
  const [eingabe, setEingabe] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const endeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endeRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [verlauf, laeuft]);

  async function absenden() {
    const frage = eingabe.trim();
    if (!frage || laeuft) return;

    // Der Verlauf fuer die API enthaelt nur echte Konversation — Fehlermeldungen
    // aus frueheren Versuchen wuerden das Modell nur verwirren.
    const gesendet: Nachricht[] = [...verlauf, { role: "user", content: frage }];
    setVerlauf(gesendet);
    setEingabe("");
    setLaeuft(true);

    try {
      const antwort = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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

      for (;;) {
        const { done, value } = await leser.read();
        if (done) break;

        puffer += decoder.decode(value, { stream: true });
        const zeilen = puffer.split("\n");
        // Die letzte Zeile kann abgeschnitten sein und wartet auf den naechsten Happen.
        puffer = zeilen.pop() ?? "";

        for (const zeile of zeilen) {
          if (!zeile.trim()) continue;
          verarbeite(JSON.parse(zeile));
        }
      }
    } catch (error) {
      setVerlauf((bisher) => [
        ...bisher,
        {
          role: "assistant",
          content: error instanceof Error ? error.message : "Unbekannter Fehler.",
          fehler: true,
        },
      ]);
    } finally {
      setLaeuft(false);
    }
  }

  function verarbeite(ereignis: Record<string, unknown>) {
    setVerlauf((bisher) => {
      const kopie = [...bisher];
      const letzte = kopie[kopie.length - 1];
      if (!letzte || letzte.role !== "assistant") return bisher;

      if (ereignis.type === "sources") {
        kopie[kopie.length - 1] = { ...letzte, sources: ereignis.sources as Quelle[] };
      } else if (ereignis.type === "text") {
        kopie[kopie.length - 1] = { ...letzte, content: letzte.content + ereignis.delta };
      } else if (ereignis.type === "error") {
        kopie[kopie.length - 1] = {
          ...letzte,
          content: letzte.content || String(ereignis.message),
          fehler: true,
        };
      }
      return kopie;
    });
  }

  const letzte = verlauf[verlauf.length - 1];
  const wartetAufErstesWort = laeuft && (!letzte || letzte.role === "user" || !letzte.content);

  return (
    <div className="karte">
      <div className="chat">
        <div className="chat-verlauf" aria-live="polite">
          {verlauf.length === 0 && (
            <div className="chat-leer">
              <h2>Was moechten Sie wissen?</h2>
              <p>
                Fragen Sie etwas zu den eingepflegten Dokumenten. Jede Antwort nennt die
                Fundstellen, auf die sie sich stuetzt.
              </p>
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
                  <span className="tippt">Recherchiere in den Dokumenten &hellip;</span>
                ) : null)}

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

          {wartetAufErstesWort && verlauf[verlauf.length - 1]?.role === "user" && (
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
                void absenden();
              }
            }}
            placeholder="Ihre Frage &hellip;"
            rows={2}
            aria-label="Ihre Frage"
            disabled={laeuft}
          />
          <button className="knopf" onClick={() => void absenden()} disabled={laeuft || !eingabe.trim()}>
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
