"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ChatPanel from "@/components/ChatPanel";
import VerlaufListe from "@/components/VerlaufListe";
import {
  getServerSnapshot,
  getSnapshot,
  initialisiere,
  nachrichtAnhaengen,
  nachrichtenVon,
  neuerChat,
  subscribe,
  verwerfeFehler,
  waehleChat,
  type Nachricht,
  type Quelle,
} from "@/lib/chatVerlauf";

/**
 * Haelt Seitenleiste und Chatfenster zusammen: liest den Verlauf vom Server,
 * kennt den aktiven Chat und fuehrt die laufende Antwort.
 */
export default function ChatBereich() {
  const { chats, aktiveId, geladen, fehler } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  /**
   * Die entstehende Antwort lebt bewusst nur im Komponenten-State. Jedes
   * Textstueck sofort zu speichern waeren hunderte Schreibvorgaenge pro
   * Antwort — gespeichert wird erst, wenn sie steht.
   */
  const [streamend, setStreamend] = useState<Nachricht | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [listeOffen, setListeOffen] = useState(false);

  /**
   * Bricht eine laufende Antwort ab.
   *
   * Vorher fehlte das: Wer den Chat wechselte oder den Tab schloss, liess die
   * Erzeugung weiterlaufen — und bezahlte sie zu Ende. Mit dem Signal endet
   * auch der Modellaufruf auf dem Server.
   */
  const abbruch = useRef<AbortController | null>(null);

  useEffect(() => {
    void initialisiere();
    return () => abbruch.current?.abort();
  }, []);

  const gespeichert = nachrichtenVon(aktiveId);
  const angezeigt = streamend ? [...gespeichert, streamend] : gespeichert;

  async function senden(frage: string) {
    if (laeuft) return;

    // Beim allerersten Absenden entsteht der Chat. Vorher liegt kein leerer
    // Eintrag herum, nur weil jemand die Seite geoeffnet hat.
    const chatId = aktiveId ?? (await neuerChat());
    if (!chatId) return;

    const frageNachricht: Nachricht = { role: "user", content: frage };

    // Der Verlauf fuer die Anfrage enthaelt nur echte Konversation —
    // Fehlermeldungen aus frueheren Versuchen wuerden das Modell nur verwirren.
    const verlauf = [...nachrichtenVon(chatId), frageNachricht]
      .filter((nachricht) => !nachricht.fehler)
      .map((nachricht) => ({ role: nachricht.role, content: nachricht.content }));

    void nachrichtAnhaengen(chatId, frageNachricht);
    setLaeuft(true);
    setStreamend({ role: "assistant", content: "" });

    const steuerung = new AbortController();
    abbruch.current = steuerung;

    let antwort: Nachricht = { role: "assistant", content: "" };
    const uebernehmen = (naechste: Nachricht) => {
      antwort = naechste;
      setStreamend(naechste);
    };

    try {
      const reaktion = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: verlauf }),
        signal: steuerung.signal,
      });

      if (!reaktion.ok || !reaktion.body) {
        const daten = await reaktion.json().catch(() => ({}));
        throw new Error(daten.error ?? `Der Server antwortete mit Status ${reaktion.status}.`);
      }

      const leser = reaktion.body.getReader();
      const decoder = new TextDecoder();
      let puffer = "";
      let abgeschlossen = false;

      for (;;) {
        const { done, value } = await leser.read();
        if (done) break;

        puffer += decoder.decode(value, { stream: true });
        const zeilen = puffer.split("\n");
        // Die letzte Zeile kann abgeschnitten sein und wartet auf den naechsten Happen.
        puffer = zeilen.pop() ?? "";

        for (const zeile of zeilen) {
          if (!zeile.trim()) continue;
          const ereignis = JSON.parse(zeile) as Record<string, unknown>;

          if (ereignis.type === "sources") {
            uebernehmen({ ...antwort, sources: ereignis.sources as Quelle[] });
          } else if (ereignis.type === "text") {
            uebernehmen({ ...antwort, content: antwort.content + String(ereignis.delta) });
          } else if (ereignis.type === "done") {
            abgeschlossen = true;
          } else if (ereignis.type === "error") {
            uebernehmen({
              ...antwort,
              content: antwort.content || String(ereignis.message),
              fehler: true,
            });
            abgeschlossen = true;
          }
        }
      }

      /**
       * Ohne "done" ist die Antwort abgeschnitten.
       *
       * Vorher galt jedes Ende des Stroms als Abschluss. Riss die Verbindung
       * oder lief die Funktion in ihr Zeitlimit, wurde die halbe Antwort als
       * vollstaendig in den Verlauf uebernommen — in einem Wissensassistenten
       * ist eine halbe Auskunft schlimmer als keine.
       */
      if (!abgeschlossen) {
        uebernehmen({
          ...antwort,
          content:
            (antwort.content ? `${antwort.content}\n\n` : "") +
            "*Die Antwort wurde unterbrochen und ist unvollstaendig. Bitte die Frage erneut stellen.*",
          fehler: true,
        });
      }

      if (antwort.content) await nachrichtAnhaengen(chatId, antwort);

      setStreamend(null);
      setLaeuft(false);
    } catch (error) {
      // Ein Abbruch durch den Nutzer ist kein Fehler, der angezeigt werden muss.
      if (steuerung.signal.aborted) {
        setStreamend(null);
        setLaeuft(false);
        return;
      }

      // Die Frage bleibt gespeichert, die Fehlermeldung nicht: eine
      // Fehlermeldung von gestern hilft beim Zuruecksprigen niemandem.
      setStreamend({
        role: "assistant",
        content: error instanceof Error ? error.message : "Unbekannter Fehler.",
        fehler: true,
      });
      setLaeuft(false);
    } finally {
      abbruch.current = null;
    }
  }

  function wechsle(id: string | null) {
    abbruch.current?.abort();
    setStreamend(null);
    setLaeuft(false);
    void waehleChat(id);
    setListeOffen(false);
  }

  return (
    <div className="chat-bereich">
      <VerlaufListe
        chats={chats}
        aktiveId={aktiveId}
        geladen={geladen}
        gesperrt={laeuft}
        offen={listeOffen}
        onUmschalten={() => setListeOffen((offen) => !offen)}
        onWaehlen={(id) => wechsle(id)}
        onNeu={() => {
          abbruch.current?.abort();
          setStreamend(null);
          setLaeuft(false);
          void neuerChat();
          setListeOffen(false);
        }}
      />

      <div>
        {fehler && (
          <div className="meldung" onClick={verwerfeFehler} role="status">
            {fehler}
          </div>
        )}
        <ChatPanel nachrichten={angezeigt} laeuft={laeuft} onSenden={senden} />
      </div>
    </div>
  );
}
