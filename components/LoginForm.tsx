"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/auth";

type Modus = "nutzer" | "admin";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  const grund = params.get("grund");
  const weiter = params.get("weiter") ?? "/";
  // Nur relative Pfade zulassen — "//fremde-domain" waere ein Open Redirect.
  const ziel = weiter.startsWith("/") && !weiter.startsWith("//") ? weiter : "/";
  const willAdmin = ziel.startsWith("/admin") || grund === "admin";

  const [modus, setModus] = useState<Modus>(willAdmin ? "admin" : "nutzer");
  const [email, setEmail] = useState("");
  const [passwort, setPasswort] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  async function anmelden(event: React.FormEvent) {
    event.preventDefault();
    setLaeuft(true);
    setFehler(null);

    try {
      const antwort = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modus === "admin" ? { password: passwort } : { email, password: passwort }),
      });

      const daten = (await antwort.json().catch(() => ({}))) as { error?: string; role?: Role };
      if (!antwort.ok) {
        setFehler(daten.error ?? "Anmeldung fehlgeschlagen.");
        return;
      }

      // Ein Nutzerkonto oeffnet keinen Admin — wer dorthin wollte, landet bei
      // seinen Sammlungen statt in einer Umleitungsschleife.
      const naechsteSeite = daten.role === "user" && ziel.startsWith("/admin") ? "/sammlungen" : ziel;
      router.replace(naechsteSeite);
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
        {modus === "admin"
          ? "Verwaltung von Nutzern, Modell und Wissensbasis."
          : "Mit dem Konto aus Ihrer Einladung anmelden."}
      </p>

      <div className="umschalter" role="tablist" aria-label="Anmeldeart">
        <button
          type="button"
          role="tab"
          aria-selected={modus === "nutzer"}
          onClick={() => setModus("nutzer")}
        >
          Nutzer
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={modus === "admin"}
          onClick={() => setModus("admin")}
        >
          Administrator
        </button>
      </div>

      {grund === "config" && (
        <div className="meldung">
          <code>AUTH_SECRET</code> ist nicht gesetzt. Solange die Variable fehlt, bleibt der
          geschuetzte Bereich vorsorglich gesperrt.
        </div>
      )}
      {grund === "admin" && (
        <div className="meldung meldung-neutral">
          Dieser Bereich ist Administratoren vorbehalten.
        </div>
      )}
      {fehler && <div className="meldung">{fehler}</div>}

      <form onSubmit={anmelden}>
        {modus === "nutzer" && (
          <div className="feld">
            <label htmlFor="email">E-Mail</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
        )}
        <div className="feld">
          <label htmlFor="passwort">Passwort</label>
          <input
            id="passwort"
            type="password"
            value={passwort}
            onChange={(event) => setPasswort(event.target.value)}
            autoComplete="current-password"
            autoFocus={modus === "admin"}
            required
          />
        </div>
        <button
          className="knopf"
          type="submit"
          disabled={laeuft || !passwort || (modus === "nutzer" && !email)}
        >
          {laeuft ? "Prüfe …" : "Anmelden"}
        </button>
      </form>
    </div>
  );
}
