"use client";

import { useState, useSyncExternalStore } from "react";
import ChatPanel from "@/components/ChatPanel";
import VerlaufListe from "@/components/VerlaufListe";
import {
  aktivSetzen,
  getServerSnapshot,
  getSnapshot,
  nachrichtAnhaengen,
  neuerChat,
  subscribe,
  type Nachricht,
  type Quelle,
} from "@/lib/chatVerlauf";

/**
 * Haelt Seitenleiste und Chatfenster zusammen: liest den Verlauf aus dem
 * Browser-Speicher, kennt den aktiven Chat und fuehrt die laufende Antwort.
 */
export default function ChatBereich() {
  const { chats, aktiveId } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /**
   * Die entstehende Antwort lebt bewusst nur im Komponenten-State. Jedes
   * Textstueck sofort nach localStorage zu schreiben waeren hunderte
   * Schreibvorgaenge pro Antwort — gespeichert wird erst, wenn sie steht.
   */
  const [streamend, setStreamend] = useState<Nachricht | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [listeOffen, setListeOffen] = useState(false);

  const aktiverChat = chats.find((chat) => chat.id === aktiveId) ?? null;
  const gespeichert = aktiverChat?.nachrichten ?? [];
  const angezeigt = streamend ? [...gespeichert, streamend] : gespeichert;

  async function senden(frage: string) {
    if (laeuft) return;

    // Beim allerersten Absenden entsteht der Chat. Vorher liegt kein leerer
    // Eintrag herum, nur weil jemand die Seite geoeffnet hat.
    const chatId = aktiverChat?.id ?? neuerChat();
    const frageNachricht: Nachricht = { role: "user", content: frage };

    nachrichtAnhaengen(chatId, frageNachricht);
    setLaeuft(true);
    setStreamend({ role: "assistant", content: "" });

    // Der Verlauf fuer die API enthaelt nur echte Konversation — Fehlermeldungen
    // aus frueheren Versuchen wuerden das Modell nur verwirren.
    const verlauf = [...gespeichert, frageNachricht]
      .filter((nachricht) => !nachricht.fehler)
      .map((nachricht) => ({ role: nachricht.role, content: nachricht.content }));

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
      });

      if (!reaktion.ok || !reaktion.body) {
        const daten = await reaktion.json().catch(() => ({}));
        throw new Error(daten.error ?? `Der Server antwortete mit Status ${reaktion.status}.`);
      }

      const leser = reaktion.body.getReader();
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
          const ereignis = JSON.parse(zeile) as Record<string, unknown>;

          if (ereignis.type === "sources") {
            uebernehmen({ ...antwort, sources: ereignis.sources as Quelle[] });
          } else if (ereignis.type === "text") {
            uebernehmen({ ...antwort, content: antwort.content + String(ereignis.delta) });
          } else if (ereignis.type === "error") {
            uebernehmen({
              ...antwort,
              content: antwort.content || String(ereignis.message),
              fehler: true,
            });
          }
        }
      }

      if (antwort.content) nachrichtAnhaengen(chatId, antwort);
    } catch (error) {
      // Die Frage bleibt gespeichert, die Fehlermeldung nicht: eine
      // Fehlermeldung von gestern hilft beim Zurueckspringen niemandem.
      setStreamend({
        role: "assistant",
        content: error instanceof Error ? error.message : "Unbekannter Fehler.",
        fehler: true,
      });
      setLaeuft(false);
      return;
    }

    setStreamend(null);
    setLaeuft(false);
  }

  return (
    <div className="chat-bereich">
      <VerlaufListe
        chats={chats}
        aktiveId={aktiveId}
        gesperrt={laeuft}
        offen={listeOffen}
        onUmschalten={() => setListeOffen((offen) => !offen)}
        onWaehlen={(id) => {
          aktivSetzen(id);
          setStreamend(null);
          setListeOffen(false);
        }}
        onNeu={() => {
          neuerChat();
          setStreamend(null);
          setListeOffen(false);
        }}
      />

      <ChatPanel nachrichten={angezeigt} laeuft={laeuft} onSenden={senden} />
    </div>
  );
}
