"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatiereDatum } from "@/lib/format";

export type SammlungZeile = {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
};

/** Alle Sammlungen aller Nutzer — fuer den Admin. */
export default function CollectionsOverview({
  sammlungen,
  vektoren,
}: {
  sammlungen: SammlungZeile[];
  /** Vektoren im gesamten Index laut Upstash — `null`, wenn nicht abrufbar. */
  vektoren: number | null;
}) {
  const router = useRouter();
  const [aktualisiert, aktualisiere] = useTransition();
  const [fehler, setFehler] = useState<string | null>(null);

  async function loesche(sammlung: SammlungZeile) {
    const ok = window.confirm(
      `Sammlung „${sammlung.name}" von ${sammlung.ownerEmail} mit ${sammlung.documentCount} Dokument(en) unwiderruflich loeschen?`,
    );
    if (!ok) return;
    setFehler(null);
    try {
      const antwort = await fetch(`/api/collections/${sammlung.id}`, { method: "DELETE" });
      if (antwort.status === 401) return void router.push("/login?weiter=/admin");
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.error ?? "Löschen fehlgeschlagen.");
      aktualisiere(() => router.refresh());
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    }
  }

  const abschnitte = sammlungen.reduce((summe, sammlung) => summe + sammlung.chunkCount, 0);

  return (
    <div className="karte">
      <h2 className="karte-titel">
        Alle Sammlungen{" "}
        <span style={{ fontWeight: 400, color: "var(--grau-600)", fontSize: 15 }}>
          · {sammlungen.length} · {abschnitte} Abschnitte
          {vektoren !== null && vektoren !== abschnitte
            ? ` · ${vektoren.toLocaleString("de-DE")} Vektoren im Index`
            : ""}
          {aktualisiert ? " · wird aktualisiert …" : ""}
        </span>
      </h2>

      {fehler && <div className="meldung">{fehler}</div>}

      {sammlungen.length === 0 ? (
        <p className="hinweis-text">Noch keine Sammlung angelegt.</p>
      ) : (
        <div className="tabelle-huelle">
          <table>
            <thead>
              <tr>
                <th>Sammlung</th>
                <th>Eigentuemer</th>
                <th className="zahl">Dokumente</th>
                <th className="zahl">Abschnitte</th>
                <th className="zahl">Angelegt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sammlungen.map((sammlung) => (
                <tr key={sammlung.id}>
                  <td>{sammlung.name}</td>
                  <td>{sammlung.ownerEmail}</td>
                  <td className="zahl">{sammlung.documentCount}</td>
                  <td className="zahl">{sammlung.chunkCount}</td>
                  <td className="zahl">{formatiereDatum(sammlung.createdAt)}</td>
                  <td className="zahl">
                    <button className="knopf-schlicht" type="button" onClick={() => void loesche(sammlung)}>
                      Löschen
                    </button>
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
