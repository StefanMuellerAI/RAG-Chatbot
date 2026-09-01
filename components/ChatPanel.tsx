"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type ChatSammlung = { id: string; name: string };

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

type Ereignis =
  | { type: "sources"; sources: Quelle[] }
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
  const sammlungId =
    gemerkt && sammlungen.some((sammlung) => sammlung.id === gemerkt) ? gemerkt : (sammlungen[0]?.id ?? "");

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
  const aktiveSammlung = sammlungen.find((sammlung) => sammlung.id === sammlungId);

  if (sammlungen.length === 0) {
    return (
      <div className="karte">
        <div className="chat-leer">
          <h2>Noch keine Sammlung</h2>
          <p>
            Der Chat beantwortet Fragen zu Ihren eigenen Dokumenten. Legen Sie zuerst unter{" "}
            <Link href="/sammlungen">Sammlungen</Link> eine an und laden Sie Dokumente hoch.
          </p>
        </div>
      </div>
    );
  }

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
            {sammlungen.map((sammlung) => (
              <option key={sammlung.id} value={sammlung.id}>
                {sammlung.name}
              </option>
            ))}
          </select>
        </div>

        <div className="chat-verlauf" aria-live="polite">
          {verlauf.length === 0 && (
            <div className="chat-leer">
              <h2>Was moechten Sie wissen?</h2>
              <p>
                {`Fragen Sie etwas zu den Dokumenten in „${aktiveSammlung?.name ?? "dieser Sammlung"}“. `}
                Jede Antwort nennt die Fundstellen, auf die sie sich stuetzt.
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
