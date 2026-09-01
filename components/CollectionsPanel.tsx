"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type SammlungKurz = {
  id: string;
  name: string;
  createdAt: string;
};

/**
 * Eigene Sammlungen: anlegen, umbenennen, loeschen, auswaehlen. Die Auswahl
 * landet als `?sammlung=` in der URL, damit die Seite die Dokumente
 * serverseitig laden kann.
 */
export default function CollectionsPanel({
  sammlungen,
  aktiveId,
}: {
  sammlungen: SammlungKurz[];
  aktiveId: string | null;
}) {
  const router = useRouter();
  const [aktualisiert, aktualisiere] = useTransition();
  const [neuerName, setNeuerName] = useState("");
  const [umbenennen, setUmbenennen] = useState<{ id: string; name: string } | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  function waehle(id: string) {
    router.push(`/sammlungen?sammlung=${encodeURIComponent(id)}`);
  }

  async function anfrage<T = unknown>(url: string, method: string, body?: unknown): Promise<T> {
    const antwort = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (antwort.status === 401) {
      router.push("/login?weiter=/sammlungen");
      throw new Error("Die Sitzung ist abgelaufen. Bitte neu anmelden.");
    }
    const daten = (await antwort.json().catch(() => ({}))) as T & { error?: string };
    if (!antwort.ok) throw new Error(daten.error ?? `Der Server antwortete mit Status ${antwort.status}.`);
    return daten;
  }

  async function anlegen(event: React.FormEvent) {
    event.preventDefault();
    if (!neuerName.trim()) return;
    setLaeuft(true);
    setFehler(null);
    try {
      const { collection } = await anfrage<{ collection: SammlungKurz }>("/api/collections", "POST", {
        name: neuerName,
      });
      setNeuerName("");
      waehle(collection.id);
      aktualisiere(() => router.refresh());
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setLaeuft(false);
    }
  }

  async function speichereNamen() {
    if (!umbenennen || !umbenennen.name.trim()) return;
    setLaeuft(true);
    setFehler(null);
    try {
      await anfrage(`/api/collections/${umbenennen.id}`, "PATCH", { name: umbenennen.name });
      setUmbenennen(null);
      aktualisiere(() => router.refresh());
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setLaeuft(false);
    }
  }

  async function loesche(sammlung: SammlungKurz) {
    const ok = window.confirm(
      `Sammlung „${sammlung.name}" mit allen Dokumenten unwiderruflich loeschen?`,
    );
    if (!ok) return;
    setLaeuft(true);
    setFehler(null);
    try {
      await anfrage(`/api/collections/${sammlung.id}`, "DELETE");
      if (sammlung.id === aktiveId) router.push("/sammlungen");
      aktualisiere(() => router.refresh());
    } catch (error) {
      setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="karte">
      <h1 className="karte-titel">
        Meine Sammlungen
        {aktualisiert && (
          <span style={{ fontWeight: 400, color: "var(--grau-600)", fontSize: 15 }}>
            {" "}· wird aktualisiert …
          </span>
        )}
      </h1>
      <p className="hinweis-text">
        Jede Sammlung ist eine eigene Wissensbasis. Im Chat waehlen Sie, welche befragt wird.
      </p>

      {fehler && <div className="meldung">{fehler}</div>}

      {sammlungen.length === 0 ? (
        <p className="hinweis-text">Noch keine Sammlung. Legen Sie unten die erste an.</p>
      ) : (
        <ul className="sammlungsliste">
          {sammlungen.map((sammlung) => {
            const aktiv = sammlung.id === aktiveId;
            const bearbeitet = umbenennen?.id === sammlung.id;
            return (
              <li key={sammlung.id} className={aktiv ? "aktiv" : undefined}>
                {bearbeitet ? (
                  <form
                    className="knopf-reihe"
                    style={{ flex: 1 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void speichereNamen();
                    }}
                  >
                    <input
                      type="text"
                      value={umbenennen.name}
                      onChange={(event) => setUmbenennen({ id: sammlung.id, name: event.target.value })}
                      maxLength={80}
                      autoFocus
                      aria-label="Neuer Name"
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <button className="knopf-schlicht" type="submit" disabled={laeuft}>
                      Speichern
                    </button>
                    <button className="knopf-schlicht" type="button" onClick={() => setUmbenennen(null)}>
                      Abbrechen
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="sammlung-name"
                      type="button"
                      onClick={() => waehle(sammlung.id)}
                      aria-current={aktiv ? "true" : undefined}
                    >
                      {sammlung.name}
                    </button>
                    <span className="knopf-reihe">
                      <button
                        className="knopf-schlicht"
                        type="button"
                        onClick={() => setUmbenennen({ id: sammlung.id, name: sammlung.name })}
                      >
                        Umbenennen
                      </button>
                      <button
                        className="knopf-schlicht"
                        type="button"
                        onClick={() => void loesche(sammlung)}
                        disabled={laeuft}
                      >
                        Löschen
                      </button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="knopf-reihe" onSubmit={anlegen} style={{ marginTop: 16 }}>
        <input
          type="text"
          value={neuerName}
          onChange={(event) => setNeuerName(event.target.value)}
          placeholder="Name der neuen Sammlung"
          maxLength={80}
          aria-label="Name der neuen Sammlung"
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="knopf" type="submit" disabled={laeuft || !neuerName.trim()}>
          Sammlung anlegen
        </button>
      </form>
    </div>
  );
}
