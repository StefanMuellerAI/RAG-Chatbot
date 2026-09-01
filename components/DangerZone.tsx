"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const BESTAETIGUNG = "LÖSCHEN";

/** Admin-Notausgang: gesamte Wissensbasis aller Nutzer leeren. */
export default function DangerZone() {
  const router = useRouter();
  const [bestaetigung, setBestaetigung] = useState("");
  const [leert, setLeert] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  async function leere() {
    setLeert(true);
    setFehler(null);
    try {
      const antwort = await fetch("/api/collection", { method: "DELETE" });
      if (antwort.status === 401) return void router.push("/login?weiter=/admin");
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? "Die Wissensbasis konnte nicht geleert werden.");
      setBestaetigung("");
      router.refresh();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setLeert(false);
    }
  }

  return (
    <div className="karte gefahr">
      <h2 className="karte-titel">Gesamte Wissensbasis löschen</h2>
      <p className="hinweis-text">
        Entfernt <b>alle</b> Sammlungen aller Nutzer, alle Dokumente, Abschnitte und
        Originaldateien. Nutzerkonten und Einstellungen bleiben bestehen. Das lässt sich nicht
        rückgängig machen — zum Bestätigen bitte <b>{BESTAETIGUNG}</b> eintippen.
      </p>

      {fehler && <div className="meldung">{fehler}</div>}

      <div className="feld" style={{ maxWidth: 260 }}>
        <label htmlFor="bestaetigung">Bestätigung</label>
        <input
          id="bestaetigung"
          type="text"
          value={bestaetigung}
          onChange={(event) => setBestaetigung(event.target.value)}
          placeholder={BESTAETIGUNG}
          autoComplete="off"
        />
      </div>

      <button
        className="knopf"
        type="button"
        onClick={() => void leere()}
        disabled={bestaetigung !== BESTAETIGUNG || leert}
      >
        {leert ? "Wird gelöscht …" : "Wissensbasis unwiderruflich löschen"}
      </button>
    </div>
  );
}
