"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Bestaetigungsdialog als Ersatz fuer window.confirm.
 *
 * Browser-Dialoge blockieren den Tab, sehen je System anders aus und lassen
 * sich nicht gestalten. Hier tut es das native <dialog>-Element: `showModal()`
 * bringt Fokusfang, Escape und den abgedunkelten Hintergrund mit, ohne
 * Bibliothek.
 *
 * `useBestaetigung()` liefert `bestaetige(...)`, das wie window.confirm ein
 * Promise<boolean> zurueckgibt, und `dialog`, das einmal im JSX der
 * Komponente stehen muss. Die Aufrufstellen bleiben damit fast unveraendert:
 *
 *   if (await bestaetige({ titel, text, bestaetigen: "Loeschen" })) …
 */

export type BestaetigungsOptionen = {
  titel: string;
  text: ReactNode;
  /** Beschriftung des bestaetigenden Knopfs, z. B. "Loeschen". */
  bestaetigen: string;
  abbrechen?: string;
};

type Offen = BestaetigungsOptionen & { antworte: (ja: boolean) => void };

export function useBestaetigung() {
  const [offen, setOffen] = useState<Offen | null>(null);

  function bestaetige(optionen: BestaetigungsOptionen): Promise<boolean> {
    return new Promise((antworte) => {
      setOffen({
        ...optionen,
        antworte: (ja) => {
          setOffen(null);
          antworte(ja);
        },
      });
    });
  }

  return { bestaetige, dialog: <BestaetigungsDialog offen={offen} /> };
}

function BestaetigungsDialog({ offen }: { offen: Offen | null }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (offen && !element.open) element.showModal();
    if (!offen && element.open) element.close();
  }, [offen]);

  if (!offen) return <dialog ref={ref} className="dialog" />;

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-titel"
      onCancel={(ereignis) => {
        // Escape: nicht schliessen lassen, sondern als "Nein" beantworten,
        // damit das wartende Promise aufgeloest wird.
        ereignis.preventDefault();
        offen.antworte(false);
      }}
      onClick={(ereignis) => {
        // Der Klick auf den Hintergrund trifft das dialog-Element selbst.
        if (ereignis.target === ref.current) offen.antworte(false);
      }}
    >
      <div className="dialog-inhalt">
        <h2 id="dialog-titel" className="karte-titel">
          {offen.titel}
        </h2>
        <p>{offen.text}</p>
        <div className="knopfzeile dialog-aktionen">
          {/* Der Fokus startet auf Abbrechen: Enter darf nichts loeschen. */}
          <button
            type="button"
            className="knopf-schlicht"
            autoFocus
            onClick={() => offen.antworte(false)}
          >
            {offen.abbrechen ?? "Abbrechen"}
          </button>
          <button type="button" className="knopf" onClick={() => offen.antworte(true)}>
            {offen.bestaetigen}
          </button>
        </div>
      </div>
    </dialog>
  );
}
