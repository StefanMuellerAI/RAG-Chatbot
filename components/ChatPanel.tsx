"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import MarkdownText from "@/components/MarkdownText";
import type { ChatLadestand, Nachricht, Quelle } from "@/lib/chatVerlauf";
import type { CollectionKind } from "@/lib/collection-kinds";
import type { ToolStep } from "@/lib/tools-types";
import { quellDownload, quellPositionHinweis, quellVorschau, tabellenCsv, zelleAlsText, type QuellVorschau } from "@/lib/chat-client";

export type ChatSammlung = {
  id: string; name: string; kind: CollectionKind; documentCount: number; updatedAt?: string;
  processingStatus?: { ready: number; pending: number; failed: number };
};
type Eigenschaften = {
  chatId: string | null; nachrichten: Nachricht[]; laeuft: boolean; status: string;
  laufFehler: string | null; retryAb: number | null; ladestand?: ChatLadestand;
  sammlungen: ChatSammlung[]; sammlung: string; onSammlung: (id: string) => void;
  detail: "compact" | "detailed"; onDetail: (wert: "compact" | "detailed") => void;
  eingabe: string; onEingabe: (text: string) => void; onSenden: (frage: string) => void;
  onStop: () => void; onRetry: (nachricht: Nachricht) => void;
  onLaden: () => Promise<boolean>; onMehr: () => Promise<boolean>;
};

export default function ChatPanel({
  chatId, nachrichten, laeuft, status, laufFehler, retryAb, ladestand,
  sammlungen, sammlung, onSammlung, detail, onDetail, eingabe, onEingabe,
  onSenden, onStop, onRetry, onLaden, onMehr,
}: Eigenschaften) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const folgt = useRef(true);
  const [amEnde, setAmEnde] = useState(true);
  const [quelle, setQuelle] = useState<Quelle | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const retryRef = useRef(onRetry);
  const ladenRef = useRef(onLaden);
  const [jetzt, setJetzt] = useState(() => Date.now());
  const [langsamerRequest, setLangsamerRequest] = useState<string | null>(null);
  const busy = Boolean(chatId && ladestand?.status !== "ready");
  const letzte = nachrichten[nachrichten.length - 1];
  const restzeit = retryAb ? Math.max(0, Math.ceil((retryAb - jetzt) / 1000)) : 0;
  const langsam = laeuft && langsamerRequest === letzte?.requestId;
  const laden = ladestand?.status === "loading" && nachrichten.length === 0;
  const selektion = sammlungen.filter((s) => !sammlung || s.id === sammlung);

  useEffect(() => { retryRef.current = onRetry; }, [onRetry]);
  useEffect(() => { ladenRef.current = onLaden; }, [onLaden]);
  const retry = useCallback((nachricht: Nachricht) => retryRef.current(nachricht), []);
  const aktualisieren = useCallback(() => { void ladenRef.current(); }, []);
  const bearbeiten = useCallback((text: string) => {
    onEingabe(text);
    inputRef.current?.focus();
  }, [onEingabe]);
  const quelleOeffnen = useCallback((quelle: Quelle) => { setQuelle(quelle); }, []);
  useEffect(() => { if (quelle) dialogRef.current?.showModal(); }, [quelle]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (nachrichten.length === 0) element.scrollTop = 0;
    else if (folgt.current) element.scrollTop = element.scrollHeight;
  }, [nachrichten, laeuft]);
  useEffect(() => {
    if (!laeuft || !letzte?.requestId) return;
    const id = letzte.requestId;
    const timer = setTimeout(() => setLangsamerRequest(id), 12_000);
    return () => clearTimeout(timer);
  }, [laeuft, letzte?.requestId]);
  useEffect(() => {
    if (!retryAb) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const aktualisieren = () => {
      const zeit = Date.now();
      setJetzt(zeit);
      if (zeit >= retryAb && timer) clearInterval(timer);
    };
    // Synchronize once for a new deadline; only tick while that deadline is active.
    const frame = requestAnimationFrame(aktualisieren);
    if (retryAb > Date.now()) timer = setInterval(aktualisieren, 1000);
    return () => { cancelAnimationFrame(frame); if (timer) clearInterval(timer); };
  }, [retryAb]);
  // The visual viewport follows the mobile keyboard; desktop falls back to CSS dvh.
  useEffect(() => {
    const viewport = window.visualViewport;
    const element = scrollRef.current?.closest<HTMLElement>(".chat-karte");
    if (!viewport || !element) return;
    const resize = () => {
      if (window.innerWidth <= 900) {
        element.style.setProperty("--chat-hoehe", `${Math.max(280, viewport.height - element.getBoundingClientRect().top - 12)}px`);
      } else element.style.removeProperty("--chat-hoehe");
    };
    resize();
    viewport.addEventListener("resize", resize);
    return () => viewport.removeEventListener("resize", resize);
  }, []);

  function absenden() {
    const frage = eingabe.trim();
    if (!frage || frage.length > 2000 || laeuft || busy || restzeit > 0) return;
    folgt.current = true;
    setAmEnde(true);
    onSenden(frage);
  }
  async function aeltereLaden() {
    const element = scrollRef.current;
    if (!element) return;
    folgt.current = false;
    const vorher = element.scrollHeight;
    const position = element.scrollTop;
    await onMehr();
    requestAnimationFrame(() => { element.scrollTop = position + element.scrollHeight - vorher; });
  }
  function nachUnten() {
    folgt.current = true;
    setAmEnde(true);
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  return (
    <div className="karte chat-karte">
      <div className="chat">
        <div className="chat-einstellungen">
          <label>Wissensbasis
            <select value={sammlung} onChange={(e) => onSammlung(e.target.value)} disabled={laeuft}>
              <option value="">Alle Sammlungen · automatisch</option>
              {sammlungen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Antwortlänge
            <select value={detail} onChange={(e) => onDetail(e.target.value as "compact" | "detailed")} disabled={laeuft}>
              <option value="compact">Kompakt</option><option value="detailed">Ausführlich</option>
            </select>
          </label>
        </div>
        <div className="chat-verlauf" ref={scrollRef} tabIndex={0} aria-label="Nachrichten"
          aria-busy={laden} onScroll={() => {
            const element = scrollRef.current;
            if (!element) return;
            folgt.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            setAmEnde(folgt.current);
          }}>
          {ladestand?.nextCursor && <button className="knopf-schlicht chat-aeltere" onClick={() => void aeltereLaden()}
            disabled={ladestand.mehrLaedt || laeuft}>
            {ladestand.mehrLaedt ? "Ältere Nachrichten werden geladen …" : "Ältere Nachrichten laden"}
          </button>}
          {laden && <div className="chat-skelett" role="status"><span>Nachrichten werden geladen …</span>
            <div /><div /><div /></div>}
          {ladestand?.fehler && <div className="meldung" role="alert">{ladestand.fehler}
            <button className="knopf-schlicht" onClick={() => void onLaden()}>Erneut laden</button>
          </div>}
          {!laden && !ladestand?.fehler && nachrichten.length === 0 && (
            <div className="chat-leer">
              <h2>Was möchten Sie wissen?</h2>
              <p>Fragen Sie zu Ihren Unterlagen. Die Antwort zeigt die verwendeten Fundstellen.</p>
              {selektion.length > 0 ? <>
                <ul className="chat-wissensbasis">{selektion.map((s) => <li key={s.id}>
                  <b>{s.name}</b>: {s.processingStatus
                    ? `${s.processingStatus.ready} bereit${s.processingStatus.pending ? ` · ${s.processingStatus.pending} in Verarbeitung` : ""}${s.processingStatus.failed ? ` · ${s.processingStatus.failed} fehlgeschlagen` : ""}`
                    : `${s.documentCount} Dateien`}
                  {s.processingStatus && (s.processingStatus.pending > 0 || s.processingStatus.failed > 0) && <> · <Link href={`/sammlungen/${s.id}`}>Verarbeitung ansehen</Link></>}
                </li>)}</ul>
                <div className="chat-vorschlaege">{starterFragen(selektion).map((frage) => (
                  <button key={frage} className="knopf-schlicht" onClick={() => bearbeiten(frage)}>{frage}</button>
                ))}</div>
              </> : <p>Starten Sie unter <Link href="/sammlungen">Sammlungen</Link> mit Ihren Dokumenten.</p>}
            </div>
          )}
          {nachrichten.map((nachricht) => <NachrichtZeile key={nachricht.id} nachricht={nachricht} chatId={chatId}
            laeuft={laeuft && nachricht.id === letzte?.id} aktionenGesperrt={laeuft || restzeit > 0 || busy}
            onBearbeiten={bearbeiten} onQuelle={quelleOeffnen} onRetry={retry} onAktualisieren={aktualisieren} />)}
        </div>
        <div className="chat-unterer-bereich">
          {!amEnde && letzte?.role === "assistant" && <button className="knopf-schlicht chat-nach-unten" onClick={nachUnten}>Zur neuesten Antwort ↓</button>}
          <div className="chat-status" role="status" aria-live="polite" aria-atomic="true">
            {laeuft ? status || "Antwort wird vorbereitet …" : busy && ladestand?.status === "loading" ? "Nachrichten werden geladen …" : ""}
            {laeuft && langsam && <span> Das dauert etwas länger. Sie können die Antwort jederzeit stoppen.</span>}
          </div>
          {laufFehler && <div className="chat-fehlermeldung" role="alert">{laufFehler}
            {restzeit > 0 && <span> Erneut versuchen in {restzeit} Sekunden.</span>}
            {!laeuft && <button className="knopf-schlicht" onClick={() => void onLaden()}>Verlauf aktualisieren</button>}
          </div>}
          <div className="chat-eingabe">
            <textarea ref={inputRef} value={eingabe} onChange={(e) => onEingabe(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); absenden();
                }
              }} placeholder={laeuft ? "Nächste Frage vorbereiten …" : "Ihre Frage …"} rows={2}
              aria-label="Ihre Frage" aria-describedby="eingabe-hinweis" />
            {laeuft ? <button className="knopf knopf-sekundaer" onClick={onStop}>Antwort stoppen</button>
              : <button className="knopf" onClick={absenden} disabled={busy || !eingabe.trim() || eingabe.trim().length > 2000 || restzeit > 0}>Senden</button>}
          </div>
          <div id="eingabe-hinweis" className="chat-eingabe-hinweis">
            <span>Enter senden · Umschalt + Enter neue Zeile</span>
            <span className={eingabe.trim().length > 2000 ? "chat-zu-lang" : ""}>{eingabe.trim().length} / 2.000 Zeichen</span>
          </div>
        </div>
      </div>
      <dialog className="quellen-dialog" ref={dialogRef} onClose={() => setQuelle(null)}>
        {quelle && <>
          <div className="quellen-dialog-kopf"><h2>{quelle.filename}</h2>
            <button className="knopf-schlicht" onClick={() => dialogRef.current?.close()}>Schließen</button></div>
          <p className="hinweis-text">{[quelle.collectionName, quelle.location].filter(Boolean).join(" · ")}</p>
          <blockquote>{quelle.snippet}</blockquote>
          <p>{quellPositionHinweis(quelle)}</p>
          <QuellenVorschau quelle={quelle} />
          {quellDownload(quelle) ? <a className="knopf" href={quellDownload(quelle)!} target="_blank" rel="noopener noreferrer">Original herunterladen</a>
            : <p>Für diese ältere Fundstelle ist kein direkter Dokumentlink gespeichert.</p>}
        </>}
      </dialog>
    </div>
  );
}

function QuellenVorschau({ quelle }: { quelle: Quelle }) {
  const vorschau = quellVorschau(quelle);
  if (!vorschau) return null;
  if (vorschau.kind === "pdf") return <p><a href={vorschau.url} target="_blank" rel="noopener noreferrer">
    {vorschau.page ? `PDF auf Seite ${vorschau.page} öffnen` : "PDF öffnen"}
  </a></p>;
  return <QuellenAudio key={vorschau.url} vorschau={vorschau} />;
}

function QuellenAudio({ vorschau }: { vorschau: Extract<QuellVorschau, { kind: "audio" }> }) {
  const [fehler, setFehler] = useState(false);
  return <div className="quellen-audio">
    {/* The transcript excerpt remains visible directly above this audio-only player. */}
    <audio controls preload="none" src={vorschau.url} aria-label="Originalaufnahme zur Fundstelle"
      onLoadedMetadata={(event) => {
        if (vorschau.start !== null) event.currentTarget.currentTime = vorschau.start;
      }} onError={() => setFehler(true)} />
    {fehler && <p role="status">Die Aufnahme konnte nicht abgespielt werden. Sie können das Original herunterladen.</p>}
  </div>;
}

const NachrichtZeile = memo(function NachrichtZeile({ nachricht, chatId, laeuft, aktionenGesperrt, onBearbeiten, onQuelle, onRetry, onAktualisieren }: {
  nachricht: Nachricht; chatId: string | null; laeuft: boolean; aktionenGesperrt: boolean;
  onBearbeiten: (text: string) => void; onQuelle: (quelle: Quelle) => void; onRetry: (n: Nachricht) => void;
  onAktualisieren: () => void;
}) {
  const unterbrochen = nachricht.fehler || ["failed", "aborted", "interrupted"].includes(nachricht.status ?? "");
  const ausstehend = !laeuft && (nachricht.status === "streaming" || nachricht.status === "pending");
  return <article className={`blase ${nachricht.role === "user" ? "blase-nutzer" : "blase-assistent"}${unterbrochen ? " blase-unvollstaendig" : ""}`}>
    <span className="sr-only">{nachricht.role === "user" ? "Sie" : "Assistent"}</span>
    {nachricht.role === "assistant" ? <>
      {nachricht.content ? <MarkdownText text={nachricht.content} sources={nachricht.sources} onQuelle={onQuelle} />
        : laeuft ? <span className="tippt">Antwort wird vorbereitet …</span> : null}
      {nachricht.sources?.length ? <Fundstellen quellen={nachricht.sources} onQuelle={onQuelle} /> : null}
      {nachricht.steps?.length ? <Abfragen steps={nachricht.steps} /> : null}
      {unterbrochen && <p className="chat-unvollstaendig">{nachricht.status === "aborted" ? "Gestoppt · unvollständige Antwort" : "Unvollständige Antwort"}</p>}
      {ausstehend && <p className="chat-unvollstaendig">Für diese Antwort liegt noch kein Abschluss vor.
        <button className="knopf-schlicht" disabled={aktionenGesperrt} onClick={onAktualisieren}>Status aktualisieren</button>
      </p>}
      {!laeuft && <AntwortAktionen nachricht={nachricht} chatId={chatId} />}
      {!laeuft && unterbrochen && chatId && nachricht.requestId && <button className="knopf-schlicht" disabled={aktionenGesperrt}
        onClick={() => onRetry(nachricht)}>Erneut versuchen</button>}
    </> : <>
      {nachricht.content}
      <div className="nachricht-aktionen"><button className="knopf-schlicht" onClick={() => onBearbeiten(nachricht.content)}>Frage bearbeiten</button></div>
    </>}
  </article>;
});

function AntwortAktionen({ nachricht, chatId }: { nachricht: Nachricht; chatId: string | null }) {
  const [hinweis, setHinweis] = useState("");
  const [grund, setGrund] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [bewertung, setBewertung] = useState<boolean | null>(nachricht.feedback?.helpful ?? null);
  async function kopieren() {
    try { await navigator.clipboard.writeText(nachricht.content); setHinweis("Antwort kopiert."); }
    catch { setHinweis("Kopieren nicht möglich. Bitte markieren Sie den Antworttext."); }
  }
  async function feedback(helpful: boolean, reason?: string) {
    if (!chatId || speichert) return;
    setSpeichert(true);
    try {
      const response = await fetch(`/api/chats/${chatId}/feedback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: nachricht.id, helpful, ...(reason ? { reason } : {}) }),
      });
      if (!response.ok) throw new Error();
      setBewertung(helpful); setGrund(false); setHinweis("Danke für Ihre Rückmeldung.");
    } catch { setHinweis("Die Rückmeldung konnte nicht gespeichert werden. Bitte erneut versuchen."); }
    finally { setSpeichert(false); }
  }
  const abgeschlossen = (!nachricht.status || nachricht.status === "completed") && !nachricht.fehler;
  return <>
    <div className="nachricht-aktionen">
      {nachricht.content && <button className="knopf-schlicht" onClick={() => void kopieren()}>Kopieren</button>}
      {abgeschlossen && chatId && <>
        <button className="knopf-schlicht" disabled={speichert} aria-pressed={bewertung === true} onClick={() => void feedback(true)}>Hilfreich</button>
        <button className="knopf-schlicht" disabled={speichert} aria-pressed={bewertung === false} onClick={() => setGrund((offen) => !offen)}>Nicht hilfreich</button>
      </>}
    </div>
    {grund && <fieldset className="feedback-gruende"><legend>Was können wir verbessern?</legend>
      {["Antwort falsch", "Quelle fehlt oder passt nicht", "Frage nicht beantwortet"].map((reason) => (
        <button key={reason} className="knopf-schlicht" disabled={speichert} onClick={() => void feedback(false, reason)}>{reason}</button>
      ))}
    </fieldset>}
    {hinweis && <p className="aktions-hinweis" role="status">{hinweis}</p>}
  </>;
}

function Fundstellen({ quellen, onQuelle }: { quellen: Quelle[]; onQuelle: (quelle: Quelle) => void }) {
  return <details className="quellen"><summary>
    <span className="quellen-anzahl">Fundstellen ({quellen.length})</span>
    <span className="quellen-dateien">{[...new Set(quellen.map((q) => q.filename))].join(", ")}</span>
  </summary><ol>{quellen.map((quelle) => <li key={quelle.n} value={quelle.n}>
    <button className="quellen-link" onClick={() => onQuelle(quelle)}>{quelle.filename}{quelle.location ? `, ${quelle.location}` : ""}</button>
    {quelle.collectionName && <span className="quellen-sammlung">{quelle.collectionName}</span>}
    <p>{quelle.snippet}</p>
  </li>)}</ol></details>;
}

const WERKZEUG_LABEL = { dokumente_durchsuchen: "Dokumentsuche", sql_ausfuehren: "Tabellenabfrage", cypher_ausfuehren: "Beziehungen" };
function Abfragen({ steps }: { steps: ToolStep[] }) {
  return <details className="abfragen"><summary>Abfragen und Ergebnisse ({steps.length})</summary>
    {steps.map((step, index) => <details key={index} className="abfrage">
      <summary><span>{WERKZEUG_LABEL[step.tool]}</span><span className="abfrage-sammlung">{step.collectionName}</span>
        <span className="abfrage-meta">{step.error ? "Keine Auswertung" : step.rowCount === undefined ? "" : `${step.rowCount} ${step.tool === "dokumente_durchsuchen" ? "Treffer" : "Zeilen"}${step.truncated ? " (gekürzt)" : ""}`}</span>
      </summary>
      {step.error && <p className="abfrage-fehler">{step.error}</p>}
      {!step.error && step.tool !== "dokumente_durchsuchen" && <Vorschau columns={step.columns ?? []} rows={step.preview ?? []} truncated={Boolean(step.truncated)} graph={step.tool === "cypher_ausfuehren"} />}
      <details className="abfrage-technik"><summary>Technische Abfrage anzeigen</summary><pre className="abfrage-text">{step.query}</pre></details>
    </details>)}
  </details>;
}
function Vorschau({ columns, rows, truncated, graph }: { columns: string[]; rows: unknown[]; truncated: boolean; graph: boolean }) {
  const [hinweis, setHinweis] = useState("");
  const zellen = (row: unknown): unknown[] => Array.isArray(row) ? row : columns.map((c) => (row as Record<string, unknown>)?.[c]);
  function exportieren() {
    const url = URL.createObjectURL(new Blob(["\ufeff", tabellenCsv(columns, rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "ergebnis-vorschau.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function kopieren() {
    try { await navigator.clipboard.writeText(tabellenCsv(columns, rows)); setHinweis("Vorschau kopiert."); }
    catch { setHinweis("Kopieren nicht möglich. Nutzen Sie den CSV-Download."); }
  }
  if (!rows.length) return <p className="abfrage-leer">Kein Ergebnis.</p>;
  return <>
    {graph && <div className="graph-pfade"><b>Gefundene Beziehungen</b><ul>
      {rows.map((row, i) => <li key={i}>{zellen(row).map(zelleAlsText).join(" · ")}</li>)}
    </ul></div>}
    <div className="tabelle-huelle"><table className="vorschau"><caption>Ergebnisvorschau{truncated ? " (gekürzt)" : ""}</caption>
      {columns.length > 0 && <thead><tr>{columns.map((c, i) => <th key={`${c}-${i}`} scope="col">{c}</th>)}</tr></thead>}
      <tbody>{rows.map((row, i) => <tr key={i}>{zellen(row).map((cell, j) => <td key={j}>{zelleAlsText(cell)}</td>)}</tr>)}</tbody>
    </table></div>
    <div className="nachricht-aktionen"><button className="knopf-schlicht" onClick={() => void kopieren()}>Vorschau kopieren</button>
      <button className="knopf-schlicht" onClick={exportieren}>Vorschau als CSV</button></div>
    <p className="aktions-hinweis" role="status">{hinweis || `${rows.length} angezeigte Zeilen werden exportiert.`}</p>
  </>;
}
function starterFragen(sammlungen: ChatSammlung[]): string[] {
  return sammlungen.slice(0, 3).map((s) => s.kind === "sql"
    ? `Welche Kennzahlen und auffälligen Unterschiede finden sich in „${s.name}“?`
    : s.kind === "graph" ? `Welche wichtigen Beziehungen enthält „${s.name}“?`
      : `Fasse die wichtigsten Inhalte aus „${s.name}“ mit Fundstellen zusammen.`);
}
