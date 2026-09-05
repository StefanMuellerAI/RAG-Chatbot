"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import ChatPanel, { type ChatSammlung } from "@/components/ChatPanel";
import VerlaufListe from "@/components/VerlaufListe";
import {
  getServerSnapshot, getSnapshot, initialisiere, ladeNachrichten, ladeWeitereChats,
  merkeAntwort, nachrichtenVon, neuerChat, subscribe, verwerfeFehler, waehleChat,
  type Nachricht, type Quelle,
} from "@/lib/chatVerlauf";
import { leseChatStrom } from "@/lib/chat-client";
import type { ToolStep } from "@/lib/tools-types";

type Anfrage = {
  chatId: string; requestId: string; question: string;
  collectionIds?: string[]; detail?: "compact" | "detailed";
};
type Lauf = { chatId: string | null; user: Nachricht; assistant: Nachricht; angenommen: boolean };

export default function ChatBereich({ sammlungen = [], userId }: { sammlungen?: ChatSammlung[]; userId: string }) {
  const stand = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { chats, aktiveId, geladen, fehler, listeLaedt, nextCursor, chatLadestand } = stand;
  const [lauf, setLauf] = useState<Lauf | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [status, setStatus] = useState("");
  const [laufFehler, setLaufFehler] = useState<string | null>(null);
  const [fehlerChat, setFehlerChat] = useState<string | null>(null);
  const [retryAb, setRetryAb] = useState<number | null>(null);
  const [listeOffen, setListeOffen] = useState(false);
  const [entwuerfe, setEntwuerfe] = useState<Record<string, string>>({});
  const [sammlung, setSammlung] = useState("");
  const [detail, setDetail] = useState<"compact" | "detailed">("compact");
  const gesperrt = useRef(false);
  const abbruch = useRef<AbortController | null>(null);
  const laufRef = useRef<Lauf | null>(null);
  const anfragen = useRef(new Map<string, Anfrage>());
  const mounted = useRef(true);
  const entwurfKey = aktiveId ?? "neu";
  const entwurf = entwuerfe[entwurfKey] ?? "";
  const geladenChat = aktiveId ? chatLadestand[aktiveId] : undefined;

  useEffect(() => {
    mounted.current = true;
    // Reset the account cache synchronously, then load the selected chat in
    // parallel with the sidebar. A deep link must not briefly behave as a new chat.
    void initialisiere(userId);
    const id = new URL(window.location.href).searchParams.get("chat");
    if (id) void waehleChat(id);
    const zurueck = () => {
      abbruch.current?.abort();
      void waehleChat(new URL(window.location.href).searchParams.get("chat"));
    };
    window.addEventListener("popstate", zurueck);
    return () => {
      mounted.current = false;
      abbruch.current?.abort();
      window.removeEventListener("popstate", zurueck);
    };
  }, [userId]);

  const setzeEntwurf = useCallback((text: string) => {
    setEntwuerfe((vorher) => ({ ...vorher, [getSnapshot().aktiveId ?? "neu"]: text }));
  }, []);

  const wechsle = useCallback((id: string | null) => {
    abbruch.current?.abort();
    if (laufRef.current?.chatId && laufRef.current.angenommen) {
      merkeAntwort(laufRef.current.chatId, [laufRef.current.user, laufRef.current.assistant]);
    }
    void waehleChat(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("chat", id); else url.searchParams.delete("chat");
    window.history.pushState(null, "", url);
    setListeOffen(false);
    setLaufFehler(null);
  }, []);

  async function senden(frage: string, wiederholen?: Anfrage) {
    const sauber = frage.trim();
    const selected = getSnapshot().aktiveId;
    if (gesperrt.current || !sauber || sauber.length > 2000) return;
    if (selected && getSnapshot().chatLadestand[selected]?.status !== "ready") return;
    gesperrt.current = true;
    setLaeuft(true);
    setStatus(selected ? "Frage wird übermittelt …" : "Chat wird angelegt …");
    setLaufFehler(null);
    setFehlerChat(selected);
    setRetryAb(null);
    const steuerung = new AbortController();
    abbruch.current = steuerung;
    const requestId = wiederholen?.requestId ?? crypto.randomUUID();
    const draftKey = selected ?? "neu";
    let aktuell: Lauf = {
      chatId: selected,
      user: { id: `${requestId}-user`, requestId, role: "user", content: sauber, status: "pending" },
      assistant: { id: `${requestId}-assistant`, requestId, role: "assistant", content: "", status: "pending" },
      angenommen: false,
    };
    const zeigen = () => {
      laufRef.current = aktuell;
      if (mounted.current) setLauf({ ...aktuell });
    };
    zeigen();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fertig = false;
    const puffern = () => {
      if (!timer) timer = setTimeout(() => { timer = null; zeigen(); }, 40);
    };
    try {
      const chatId = wiederholen?.chatId ?? selected ?? await neuerChat();
      if (!chatId) throw new Error("Der Chat konnte nicht angelegt werden. Ihre Frage bleibt im Eingabefeld.");
      aktuell = { ...aktuell, chatId };
      setFehlerChat(chatId);
      if (!selected && mounted.current) setEntwuerfe((vorher) => ({
        ...vorher, [chatId]: vorher[draftKey] ?? sauber, [draftKey]: "",
      }));
      const anfrage: Anfrage = wiederholen ?? {
        chatId, requestId, question: sauber, detail,
        ...(sammlung ? { collectionIds: [sammlung] } : {}),
      };
      anfragen.current.set(requestId, anfrage);
      if (steuerung.signal.aborted) throw new DOMException("Abgebrochen", "AbortError");
      const url = new URL(window.location.href);
      url.searchParams.set("chat", chatId);
      window.history.replaceState(null, "", url);
      zeigen();
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(anfrage), signal: steuerung.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        const retry = Number(body.retryAfter ?? response.headers.get("Retry-After"));
        if (Number.isFinite(retry) && retry > 0) setRetryAb(Date.now() + retry * 1000);
        throw new Error(body.error ?? `Der Server antwortete mit Status ${response.status}.`);
      }
      await leseChatStrom(response.body, (event) => {
        if (event.type === "start") {
          aktuell = { ...aktuell, angenommen: true,
            user: { ...aktuell.user, id: String(event.userMessageId), status: "completed" },
            assistant: { ...aktuell.assistant, id: String(event.assistantMessageId), status: "streaming" },
          };
          // Clear only the submitted draft; a new draft typed during the wait survives.
          setEntwuerfe((vorher) => ({ ...vorher,
            [chatId]: vorher[chatId]?.trim() === sauber ? "" : (vorher[chatId] ?? ""),
          }));
          zeigen();
        } else if (event.type === "status") {
          setStatus(String(event.message ?? "Antwort wird vorbereitet …"));
        } else if (event.type === "text") {
          aktuell = { ...aktuell, assistant: { ...aktuell.assistant,
            content: aktuell.assistant.content + String(event.delta ?? "") } };
          puffern();
        } else if (event.type === "sources") {
          aktuell = { ...aktuell, assistant: { ...aktuell.assistant, sources: event.sources as Quelle[] } };
          puffern();
        } else if (event.type === "step") {
          aktuell = { ...aktuell, assistant: { ...aktuell.assistant,
            steps: [...(aktuell.assistant.steps ?? []), event.step as ToolStep] } };
          puffern();
        } else if (event.type === "error") {
          setLaufFehler(String(event.message ?? "Die Antwort konnte nicht beendet werden."));
          const retry = Number(event.retryAfter);
          if (Number.isFinite(retry) && retry > 0) setRetryAb(Date.now() + retry * 1000);
          aktuell = { ...aktuell, assistant: { ...aktuell.assistant, status: "failed" } };
        } else if (event.type === "done") {
          fertig = true;
          const status = event.status === "failed" || event.status === "aborted" ? event.status : "completed";
          aktuell = { ...aktuell, assistant: { ...aktuell.assistant, status } };
        }
      });
      if (!fertig) throw new Error("Die Verbindung wurde unterbrochen. Die Antwort ist unvollständig.");
    } catch (error) {
      aktuell = { ...aktuell, assistant: { ...aktuell.assistant,
        status: steuerung.signal.aborted ? "aborted" : "failed" } };
      if (mounted.current) setLaufFehler(steuerung.signal.aborted
        ? "Antwort gestoppt. Der bisherige Text bleibt erhalten."
        : error instanceof Error ? error.message : "Die Antwort konnte nicht geladen werden.");
    } finally {
      if (timer) clearTimeout(timer);
      zeigen();
      gesperrt.current = false;
      abbruch.current = null;
      if (mounted.current) { setLaeuft(false); setStatus(""); }
      if (aktuell.chatId && aktuell.angenommen && mounted.current) {
        const id = aktuell.chatId;
        merkeAntwort(id, [aktuell.user, aktuell.assistant]);
        // Refresh independently: stopping a stream must not lock navigation until a GET finishes.
        void ladeNachrichten(id, true).then((refreshed) => {
          if (!mounted.current) return;
          const saved = nachrichtenVon(id).find((n) => n.id === aktuell.assistant.id);
          if (refreshed && saved && saved.status !== "streaming" && saved.status !== "pending"
            && saved.content.length >= aktuell.assistant.content.length) {
            if (laufRef.current?.user.requestId === requestId) { laufRef.current = null; setLauf(null); }
          } else {
            merkeAntwort(id, [aktuell.user, aktuell.assistant]);
            if (laufRef.current?.user.requestId === requestId) setLaufFehler((vorher) => vorher
              ?? "Der Speicherstand konnte noch nicht bestätigt werden. Bitte Verlauf erneut laden.");
          }
        });
      }
    }
  }

  const wiederholen = (nachricht: Nachricht) => {
    if (!aktiveId || !nachricht.requestId) return;
    const gespeichert = anfragen.current.get(nachricht.requestId);
    const frage = nachrichtenVon(aktiveId).find((n) => n.requestId === nachricht.requestId && n.role === "user")
      ?? (lauf?.user.requestId === nachricht.requestId ? lauf.user : undefined);
    if (gespeichert) void senden(gespeichert.question, gespeichert);
    else if (frage) void senden(frage.content, {
      chatId: aktiveId, requestId: nachricht.requestId, question: frage.content,
      ...(nachricht.request?.collectionIds ? { collectionIds: nachricht.request.collectionIds } : {}),
      ...(nachricht.request?.detail ? { detail: nachricht.request.detail } : {}),
    });
  };
  const gespeichert = nachrichtenVon(aktiveId);
  const sichtbarerLauf = lauf && (lauf.chatId === aktiveId || (!aktiveId && !lauf.chatId)) ? lauf : null;
  const angezeigt = sichtbarerLauf ? [
    ...gespeichert.filter((n) => n.requestId !== sichtbarerLauf.user.requestId),
    sichtbarerLauf.user, sichtbarerLauf.assistant,
  ] : gespeichert;

  return (
    <div className="chat-bereich">
      <VerlaufListe chats={chats} aktiveId={aktiveId} geladen={geladen} gesperrt={laeuft}
        offen={listeOffen} onUmschalten={() => setListeOffen((offen) => !offen)}
        onWaehlen={wechsle} onNeu={() => wechsle(null)} mehr={Boolean(nextCursor)} laedt={listeLaedt}
        onMehr={() => void ladeWeitereChats()} />
      <div className="chat-haupt">
        {fehler && <div className="meldung" role="status">{fehler}
          <button className="knopf-schlicht" onClick={() => void initialisiere(userId, true)}>Erneut laden</button>
          <button className="knopf-schlicht" onClick={verwerfeFehler} aria-label="Hinweis schließen">Schließen</button>
        </div>}
        <ChatPanel key={aktiveId ?? "neu"} chatId={aktiveId} nachrichten={angezeigt}
          laeuft={laeuft} status={status} laufFehler={fehlerChat === aktiveId ? laufFehler : null} retryAb={fehlerChat === aktiveId ? retryAb : null}
          ladestand={geladenChat} sammlungen={sammlungen} sammlung={sammlung} onSammlung={setSammlung}
          detail={detail} onDetail={setDetail} eingabe={entwurf} onEingabe={setzeEntwurf}
          onSenden={(frage) => void senden(frage)} onStop={() => { setStatus("Antwort wird gestoppt …"); abbruch.current?.abort(); }}
          onRetry={wiederholen} onLaden={() => aktiveId ? ladeNachrichten(aktiveId, true) : Promise.resolve(true)}
          onMehr={() => aktiveId ? ladeNachrichten(aktiveId, false, true) : Promise.resolve(true)} />
      </div>
    </div>
  );
}
