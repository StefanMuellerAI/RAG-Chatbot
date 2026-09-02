"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PlanMitKlasse } from "@/lib/admin";
import type { Einladung } from "@/lib/einladungen";

/**
 * Abschnitt „Einladungen" der Administration.
 *
 * Der Admin traegt eine Adresse ein und waehlt den Plan, den die Person nach
 * der Registrierung haben soll. Clerk verschickt die Mail. Weil Mails auch mal
 * nicht ankommen, zeigt die Karte nach dem Anlegen den Einladungslink zum
 * Kopieren — derselbe Link, der in der Mail steht.
 */

type Eigenschaften = {
  /** null, wenn die Liste nicht geladen werden konnte (z. B. Clerk nicht erreichbar). */
  einladungen: Einladung[] | null;
  plaene: PlanMitKlasse[];
  gesperrt: boolean;
  sende: (
    pfad: string,
    methode: "PUT" | "PATCH" | "DELETE",
    koerper?: unknown,
  ) => Promise<boolean>;
};

export default function EinladungenKarte({ einladungen, plaene, gesperrt, sende }: Eigenschaften) {
  const router = useRouter();
  const [aktualisiert, starte] = useTransition();

  const standard = plaene.find((plan) => plan.isDefault)?.id ?? plaene[0]?.id ?? "";
  const [email, setEmail] = useState("");
  const [planId, setPlanId] = useState(standard);
  const [sendet, setSendet] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [verschickt, setVerschickt] = useState<Einladung | null>(null);

  const beschaeftigt = gesperrt || sendet || aktualisiert;

  async function einladen() {
    setSendet(true);
    setFehler(null);
    setVerschickt(null);

    try {
      const antwort = await fetch("/api/admin/einladungen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, planId }),
      });
      const daten = (await antwort.json().catch(() => ({}))) as {
        einladung?: Einladung;
        error?: string;
      };
      if (!antwort.ok || !daten.einladung) {
        throw new Error(daten.error ?? `Status ${antwort.status}`);
      }

      setVerschickt(daten.einladung);
      setEmail("");
      starte(() => router.refresh());
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setSendet(false);
    }
  }

  function planLabel(id: string | null): string {
    if (!id) return "Standardplan";
    return plaene.find((plan) => plan.id === id)?.label ?? id;
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">
        Einladungen
        {einladungen && einladungen.length > 0 && (
          <span className="karte-zusatz"> · {einladungen.length} offen</span>
        )}
      </h2>
      <p className="hinweis-text">
        Clerk verschickt die Einladung per E-Mail; der Link fuehrt zur Registrierung und gilt
        14 Tage. Der gewaehlte Plan wird der Person nach der Registrierung zugewiesen. Soll
        die App nur Eingeladenen offenstehen, im Clerk-Dashboard unter{" "}
        <i>Configure → Restrictions</i> den Sign-up-Modus auf <b>Restricted</b> stellen.
      </p>

      <form
        className="knopfzeile"
        style={{ alignItems: "center", marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void einladen();
        }}
      >
        <input
          type="email"
          className="feld-schmal"
          style={{ width: 300 }}
          value={email}
          disabled={beschaeftigt}
          placeholder="name@example.de"
          autoComplete="off"
          aria-label="E-Mail-Adresse der einzuladenden Person"
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          value={planId}
          style={{ width: "auto" }}
          disabled={beschaeftigt}
          aria-label="Plan fuer die eingeladene Person"
          onChange={(e) => setPlanId(e.target.value)}
        >
          {plaene.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.label}
              {plan.isDefault ? " (Standard)" : ""}
            </option>
          ))}
        </select>
        <button type="submit" className="knopf-schlicht" disabled={beschaeftigt || !email.trim()}>
          {sendet ? "Verschickt …" : "Einladen"}
        </button>
      </form>

      {fehler && <div className="meldung">{fehler}</div>}

      {verschickt && !fehler && (
        <div className="meldung meldung-neutral">
          <p>
            Einladung an <b>{verschickt.email}</b> verschickt
            {verschickt.planId ? ` (Plan ${planLabel(verschickt.planId)})` : ""}.
          </p>
          {verschickt.url && (
            <p>
              Falls die Mail nicht ankommt, fuehrt dieser Link zur Registrierung:{" "}
              <LinkKopieren url={verschickt.url} />
            </p>
          )}
        </div>
      )}

      {einladungen === null ? (
        <div className="meldung">
          Die offenen Einladungen konnten nicht geladen werden. Ist <code>CLERK_SECRET_KEY</code>{" "}
          gesetzt und Clerk erreichbar?
        </div>
      ) : (
        <div className="tabelle-huelle">
          <table>
            <thead>
              <tr>
                <th>E-Mail</th>
                <th>Plan</th>
                <th className="zahl">Eingeladen am</th>
                <th className="zahl">Gueltig bis</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {einladungen.map((einladung) => (
                <tr key={einladung.id}>
                  <td>{einladung.email}</td>
                  <td>{planLabel(einladung.planId)}</td>
                  <td className="zahl">{datum(einladung.createdAt)}</td>
                  <td className="zahl">{datum(einladung.expiresAt)}</td>
                  <td className="zahl">
                    <button
                      className="knopf-schlicht"
                      disabled={beschaeftigt}
                      onClick={() => {
                        if (window.confirm(`Einladung an ${einladung.email} widerrufen?`)) {
                          void sende(
                            `/api/admin/einladungen/${encodeURIComponent(einladung.id)}`,
                            "DELETE",
                          );
                        }
                      }}
                    >
                      Widerrufen
                    </button>
                  </td>
                </tr>
              ))}

              {einladungen.length === 0 && (
                <tr>
                  <td colSpan={5} className="hinweis-text" style={{ margin: 0 }}>
                    Keine offenen Einladungen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LinkKopieren({ url }: { url: string }) {
  const [kopiert, setKopiert] = useState(false);

  async function kopiere() {
    try {
      await navigator.clipboard.writeText(url);
      setKopiert(true);
      window.setTimeout(() => setKopiert(false), 2000);
    } catch {
      // Ohne Zwischenablage (z. B. ohne HTTPS) bleibt das Feld zum Markieren.
      setKopiert(false);
    }
  }

  return (
    <span className="knopfzeile" style={{ display: "inline-flex", alignItems: "center" }}>
      <input
        type="text"
        className="feld-schmal"
        style={{ width: 360 }}
        readOnly
        value={url}
        aria-label="Einladungslink"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="knopf-schlicht" onClick={() => void kopiere()}>
        {kopiert ? "Kopiert" : "Kopieren"}
      </button>
    </span>
  );
}

function datum(wert: string): string {
  return new Date(wert).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
