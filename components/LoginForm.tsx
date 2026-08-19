"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [passwort, setPasswort] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const grund = params.get("grund");
  const weiter = params.get("weiter") ?? "/admin";

  async function anmelden(event: React.FormEvent) {
    event.preventDefault();
    setLaeuft(true);
    setFehler(null);

    try {
      const antwort = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwort }),
      });

      if (!antwort.ok) {
        const daten = await antwort.json().catch(() => ({}));
        setFehler(daten.error ?? "Anmeldung fehlgeschlagen.");
        return;
      }

      // Vollstaendige Navigation, damit die Middleware das frische Cookie sieht.
      router.replace(weiter.startsWith("/") ? weiter : "/admin");
      router.refresh();
    } catch {
      setFehler("Der Server ist nicht erreichbar.");
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="karte anmeldung">
      <h1 className="karte-titel">Anmeldung</h1>
      <p className="hinweis-text">
        Die Dokumentenverwaltung ist passwortgeschuetzt. Der Chat ist ohne Anmeldung
        nutzbar.
      </p>

      {grund === "config" && (
        <div className="meldung">
          <code>AUTH_SECRET</code> ist nicht gesetzt. Solange die Variable fehlt, bleibt der
          Admin-Bereich vorsorglich gesperrt.
        </div>
      )}
      {fehler && <div className="meldung">{fehler}</div>}

      <form onSubmit={anmelden}>
        <div className="feld">
          <label htmlFor="passwort">Passwort</label>
          <input
            id="passwort"
            type="password"
            value={passwort}
            onChange={(event) => setPasswort(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>
        <button className="knopf" type="submit" disabled={laeuft || !passwort}>
          {laeuft ? "Prüfe …" : "Anmelden"}
        </button>
      </form>
    </div>
  );
}
