"use client";

import { useState } from "react";
import { useBestaetigung } from "@/components/BestaetigungsDialog";
import { alleLoeschen, loeschen, umbenennen, type Chat } from "@/lib/chatVerlauf";

type Eigenschaften = {
  chats: Chat[];
  aktiveId: string | null;
  /** Erst nach dem ersten Abruf steht fest, ob es Chats gibt. */
  geladen: boolean;
  /** Waehrend eine Antwort laeuft, bleibt die Liste unangetastet. */
  gesperrt: boolean;
  /** Nur auf schmalen Schirmen relevant, wo die Liste zusammenklappt. */
  offen: boolean;
  onUmschalten: () => void;
  onWaehlen: (id: string) => void;
  onNeu: () => void;
};

export default function VerlaufListe({
  chats,
  aktiveId,
  geladen,
  gesperrt,
  offen,
  onUmschalten,
  onWaehlen,
  onNeu,
}: Eigenschaften) {
  const [bearbeitet, setBearbeitet] = useState<string | null>(null);
  const [entwurf, setEntwurf] = useState("");
  const { bestaetige, dialog } = useBestaetigung();

  async function loescheChat(chat: Chat) {
    const ja = await bestaetige({
      titel: `„${chat.titel}" löschen?`,
      text: "Der Chat und seine Nachrichten werden endgültig entfernt.",
      bestaetigen: "Löschen",
    });
    if (ja) void loeschen(chat.id);
  }

  async function loescheAlle() {
    const ja = await bestaetige({
      titel: `Alle ${chats.length} Chats löschen?`,
      text: "Der gesamte Verlauf wird endgültig entfernt. Das lässt sich nicht rückgängig machen.",
      bestaetigen: "Alle löschen",
    });
    if (ja) void alleLoeschen();
  }

  function starteUmbenennen(chat: Chat) {
    setBearbeitet(chat.id);
    setEntwurf(chat.titel);
  }

  function speichereUmbenennen() {
    if (bearbeitet) void umbenennen(bearbeitet, entwurf);
    setBearbeitet(null);
  }

  return (
    <aside className={offen ? "verlauf verlauf-offen" : "verlauf"} aria-label="Chat-Historie">
      <button className="verlauf-umschalter" onClick={onUmschalten} aria-expanded={offen}>
        Chats ({chats.length})
      </button>

      <div className="verlauf-inhalt">
        <button className="knopf knopf-sekundaer verlauf-neu" onClick={onNeu} disabled={gesperrt}>
          + Neuer Chat
        </button>

        {chats.length === 0 ? (
          <p className="verlauf-leer">
            {geladen
              ? "Noch keine Chats. Ihre erste Frage legt automatisch einen an."
              : "Verlauf wird geladen …"}
          </p>
        ) : (
          <ul className="verlauf-liste">
            {chats.map((chat) => (
              <li
                key={chat.id}
                className={chat.id === aktiveId ? "verlauf-eintrag aktiv" : "verlauf-eintrag"}
              >
                {bearbeitet === chat.id ? (
                  <input
                    type="text"
                    className="verlauf-eingabe"
                    value={entwurf}
                    onChange={(event) => setEntwurf(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        speichereUmbenennen();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setBearbeitet(null);
                      }
                    }}
                    onBlur={speichereUmbenennen}
                    aria-label="Chat benennen"
                    autoFocus
                  />
                ) : (
                  <>
                    <button
                      className="verlauf-titel"
                      onClick={() => onWaehlen(chat.id)}
                      onDoubleClick={() => !gesperrt && starteUmbenennen(chat)}
                      disabled={gesperrt}
                      title={chat.titel}
                    >
                      {chat.titel}
                    </button>

                    {/* Dauerhaft sichtbar statt nur bei Hover — reine
                        Hover-Bedienelemente sind auf Touch nicht erreichbar. */}
                    <button
                      className="verlauf-aktion"
                      onClick={() => starteUmbenennen(chat)}
                      disabled={gesperrt}
                      aria-label={`"${chat.titel}" umbenennen`}
                    >
                      <StiftSymbol />
                    </button>
                    <button
                      className="verlauf-aktion"
                      onClick={() => void loescheChat(chat)}
                      disabled={gesperrt}
                      aria-label={`"${chat.titel}" löschen`}
                    >
                      <PapierkorbSymbol />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {chats.length > 0 && (
          <button
            className="verlauf-alle-loeschen"
            onClick={() => void loescheAlle()}
            disabled={gesperrt}
          >
            Alle Chats löschen
          </button>
        )}
      </div>

      {dialog}
    </aside>
  );
}

function StiftSymbol() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M11.5 1.5 14.5 4.5 5.5 13.5 1.5 14.5 2.5 10.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PapierkorbSymbol() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 10h6.4L12 4M6.5 6.5v5M9.5 6.5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
