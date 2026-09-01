"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-rules";

export default function InviteAcceptForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [passwort, setPasswort] = useState("");
  const [wiederholung, setWiederholung] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const zuKurz = passwort.length > 0 && passwort.length < MIN_PASSWORD_LENGTH;
  const ungleich = wiederholung.length > 0 && passwort !== wiederholung;
  const bereit = passwort.length >= MIN_PASSWORD_LENGTH && passwort === wiederholung;

  async function annehmen(event: React.FormEvent) {
    event.preventDefault();
    if (!bereit) return;
    setLaeuft(true);
    setFehler(null);

    try {
      const antwort = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: passwort }),
      });
      const daten = (await antwort.json().catch(() => ({}))) as { error?: string };
      if (!antwort.ok) {
        setFehler(daten.error ?? "Die Einladung konnte nicht angenommen werden.");
        return;
      }
      router.replace("/sammlungen");
      router.refresh();
    } catch {
      setFehler("Der Server ist nicht erreichbar.");
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="karte anmeldung">
      <h1 className="karte-titel">Konto einrichten</h1>
      <p className="hinweis-text">
        Sie wurden als <b>{email}</b> eingeladen. Legen Sie ein Passwort fest — damit melden Sie
        sich kuenftig an.
      </p>

      {fehler && <div className="meldung">{fehler}</div>}

      <form onSubmit={annehmen}>
        <div className="feld">
          <label htmlFor="passwort">Passwort (mindestens {MIN_PASSWORD_LENGTH} Zeichen)</label>
          <input
            id="passwort"
            type="password"
            value={passwort}
            onChange={(event) => setPasswort(event.target.value)}
            autoComplete="new-password"
            autoFocus
            required
            aria-invalid={zuKurz || undefined}
          />
          {zuKurz && <div className="feld-hinweis">Noch {MIN_PASSWORD_LENGTH - passwort.length} Zeichen.</div>}
        </div>
        <div className="feld">
          <label htmlFor="wiederholung">Passwort wiederholen</label>
          <input
            id="wiederholung"
            type="password"
            value={wiederholung}
            onChange={(event) => setWiederholung(event.target.value)}
            autoComplete="new-password"
            required
            aria-invalid={ungleich || undefined}
          />
          {ungleich && <div className="feld-hinweis">Die Passwoerter stimmen nicht ueberein.</div>}
        </div>
        <button className="knopf" type="submit" disabled={laeuft || !bereit}>
          {laeuft ? "Richte ein …" : "Konto anlegen und anmelden"}
        </button>
      </form>
    </div>
  );
}
