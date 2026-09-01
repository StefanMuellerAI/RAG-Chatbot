"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatiereDatum } from "@/lib/format";

export type NutzerZeile = {
  id: string;
  email: string;
  createdAt: string;
  disabled: boolean;
  collectionCount: number;
};

export type EinladungZeile = {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
};

type Meldung = { art: "erfolg" | "fehler" | "neutral"; text: string };

/** Nutzer einladen, sperren, loeschen; offene Einladungen widerrufen. */
export default function UsersCard({
  nutzer,
  einladungen,
}: {
  nutzer: NutzerZeile[];
  einladungen: EinladungZeile[];
}) {
  const router = useRouter();
  const [aktualisiert, aktualisiere] = useTransition();
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [kopiert, setKopiert] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState<Meldung | null>(null);

  async function anfrage<T = unknown>(url: string, method: string, body?: unknown): Promise<T> {
    const antwort = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (antwort.status === 401) {
      router.push("/login?weiter=/admin");
      throw new Error("Die Sitzung ist abgelaufen. Bitte neu anmelden.");
    }
    const daten = (await antwort.json().catch(() => ({}))) as T & { error?: string };
    if (!antwort.ok) throw new Error(daten.error ?? `Der Server antwortete mit Status ${antwort.status}.`);
    return daten;
  }

  async function einladen(event: React.FormEvent) {
    event.preventDefault();
    setLaeuft(true);
    setMeldung(null);
    setLink(null);
    setKopiert(false);
    try {
      const daten = await anfrage<{ link: string }>("/api/invites", "POST", { email });
      setLink({ email: email.trim(), url: daten.link });
      setEmail("");
      aktualisiere(() => router.refresh());
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    } finally {
      setLaeuft(false);
    }
  }

  async function kopiere() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setKopiert(true);
    } catch {
      setMeldung({ art: "neutral", text: "Kopieren nicht moeglich — bitte den Link markieren und manuell kopieren." });
    }
  }

  async function widerrufe(einladung: EinladungZeile) {
    setMeldung(null);
    try {
      await anfrage(`/api/invites/${encodeURIComponent(einladung.id)}`, "DELETE");
      aktualisiere(() => router.refresh());
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    }
  }

  async function sperre(zeile: NutzerZeile) {
    setMeldung(null);
    try {
      await anfrage(`/api/users/${zeile.id}`, "PATCH", { disabled: !zeile.disabled });
      aktualisiere(() => router.refresh());
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    }
  }

  async function loesche(zeile: NutzerZeile) {
    const ok = window.confirm(
      `Konto ${zeile.email} samt ${zeile.collectionCount} Sammlung(en) und allen Dokumenten unwiderruflich loeschen?`,
    );
    if (!ok) return;
    setMeldung(null);
    try {
      await anfrage(`/api/users/${zeile.id}`, "DELETE");
      aktualisiere(() => router.refresh());
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    }
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">
        Nutzer
        {aktualisiert && (
          <span style={{ fontWeight: 400, color: "var(--grau-600)", fontSize: 15 }}>
            {" "}· wird aktualisiert …
          </span>
        )}
      </h2>
      <p className="hinweis-text">
        Eingeladene setzen ueber den Link ein eigenes Passwort und koennen danach Sammlungen
        anlegen. Der Link ist 7 Tage gueltig und wird nur einmal angezeigt.
      </p>

      {meldung && <div className={`meldung meldung-${meldung.art}`}>{meldung.text}</div>}

      <form className="knopf-reihe" onSubmit={einladen}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@beispiel.de"
          aria-label="E-Mail-Adresse der einzuladenden Person"
          required
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="knopf" type="submit" disabled={laeuft || !email.trim()}>
          {laeuft ? "Erzeuge Link …" : "Einladen"}
        </button>
      </form>

      {link && (
        <div className="meldung meldung-erfolg" style={{ marginTop: 16 }}>
          <b>Einladung fuer {link.email}.</b> Diesen Link weitergeben:
          <div className="knopf-reihe" style={{ marginTop: 8 }}>
            <input type="text" readOnly value={link.url} onFocus={(event) => event.target.select()} style={{ flex: 1, minWidth: 260 }} />
            <button className="knopf-schlicht" type="button" onClick={() => void kopiere()}>
              {kopiert ? "Kopiert" : "Kopieren"}
            </button>
          </div>
        </div>
      )}

      {einladungen.length > 0 && (
        <>
          <h3 className="unter-titel">Offene Einladungen</h3>
          <div className="tabelle-huelle">
            <table>
              <thead>
                <tr>
                  <th>E-Mail</th>
                  <th className="zahl">Erstellt</th>
                  <th className="zahl">Gueltig bis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {einladungen.map((einladung) => (
                  <tr key={einladung.id}>
                    <td>{einladung.email}</td>
                    <td className="zahl">{formatiereDatum(einladung.createdAt)}</td>
                    <td className="zahl">{formatiereDatum(einladung.expiresAt)}</td>
                    <td className="zahl">
                      <button className="knopf-schlicht" type="button" onClick={() => void widerrufe(einladung)}>
                        Widerrufen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="unter-titel">Konten</h3>
      {nutzer.length === 0 ? (
        <p className="hinweis-text">Noch keine Nutzerkonten.</p>
      ) : (
        <div className="tabelle-huelle">
          <table>
            <thead>
              <tr>
                <th>E-Mail</th>
                <th className="zahl">Seit</th>
                <th className="zahl">Sammlungen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {nutzer.map((zeile) => (
                <tr key={zeile.id}>
                  <td>{zeile.email}</td>
                  <td className="zahl">{formatiereDatum(zeile.createdAt)}</td>
                  <td className="zahl">{zeile.collectionCount}</td>
                  <td>{zeile.disabled ? <span className="status-fehler">gesperrt</span> : "aktiv"}</td>
                  <td className="zahl">
                    <span className="knopf-reihe" style={{ justifyContent: "flex-end" }}>
                      <button className="knopf-schlicht" type="button" onClick={() => void sperre(zeile)}>
                        {zeile.disabled ? "Entsperren" : "Sperren"}
                      </button>
                      <button className="knopf-schlicht" type="button" onClick={() => void loesche(zeile)}>
                        Löschen
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : "Unbekannter Fehler.";
}
