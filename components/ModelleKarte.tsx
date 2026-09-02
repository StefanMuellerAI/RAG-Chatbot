"use client";

import { useState } from "react";
import { useBestaetigung } from "@/components/BestaetigungsDialog";
import type { KatalogEintrag, ModellEingabe } from "@/lib/admin";
import type { VerfuegbaresModell } from "@/lib/anbieter-modelle";
import {
  ANBIETER,
  ANBIETER_LABEL,
  KEY_ANBIETER,
  type Anbieter,
  type KeyAnbieter,
} from "@/lib/models";
import type { KeyStatusUebersicht } from "@/lib/provider-keys";

/**
 * Abschnitt „KI-Modelle" der Administration: Anbieter-Keys und Modellkatalog.
 *
 * Keys werden nur beim Speichern gesendet und kommen nie zurueck — die
 * Oberflaeche kennt nur die Maske. Der Katalog ist wie die uebrigen Tabellen
 * der Konsole direkt in der Zeile editierbar.
 */

const KEY_PLATZHALTER: Record<KeyAnbieter, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
};

type KeyAktionen = {
  /** true bei Erfolg — das Feld leert sich dann. */
  onKeySpeichern: (provider: KeyAnbieter, key: string) => Promise<boolean>;
  onKeyLoeschen: (provider: KeyAnbieter) => Promise<boolean>;
};

type KatalogAktionen = {
  onModellSpeichern: (werte: ModellEingabe) => Promise<boolean>;
  onModellLoeschen: (id: string) => Promise<boolean>;
};

type Eigenschaften = KeyAktionen &
  KatalogAktionen & {
    katalog: KatalogEintrag[];
    keyStatus: KeyStatusUebersicht;
    secretKonfiguriert: boolean;
    gesperrt: boolean;
  };

export default function ModelleKarte({
  katalog,
  keyStatus,
  secretKonfiguriert,
  gesperrt,
  onKeySpeichern,
  onKeyLoeschen,
  onModellSpeichern,
  onModellLoeschen,
}: Eigenschaften) {
  return (
    <>
      <AnbieterKeysKarte
        keyStatus={keyStatus}
        secretKonfiguriert={secretKonfiguriert}
        gesperrt={gesperrt}
        onKeySpeichern={onKeySpeichern}
        onKeyLoeschen={onKeyLoeschen}
      />
      <KatalogKarte
        katalog={katalog}
        keyStatus={keyStatus}
        gesperrt={gesperrt}
        onModellSpeichern={onModellSpeichern}
        onModellLoeschen={onModellLoeschen}
      />
    </>
  );
}

// --- Anfragen mit Antwortkoerper ---------------------------------------------

async function anfrage<T>(pfad: string, methode: "GET" | "POST", koerper?: unknown): Promise<T> {
  const antwort = await fetch(pfad, {
    method: methode,
    headers: koerper ? { "Content-Type": "application/json" } : undefined,
    body: koerper ? JSON.stringify(koerper) : undefined,
  });
  const daten = (await antwort.json().catch(() => ({}))) as T & { error?: string };
  if (!antwort.ok) throw new Error(daten.error ?? `Status ${antwort.status}`);
  return daten;
}

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : "Unbekannter Fehler.";
}

// --- Anbieter-Keys ------------------------------------------------------------

function AnbieterKeysKarte({
  keyStatus,
  secretKonfiguriert,
  gesperrt,
  onKeySpeichern,
  onKeyLoeschen,
}: KeyAktionen & Pick<Eigenschaften, "keyStatus" | "secretKonfiguriert" | "gesperrt">) {
  const { bestaetige, dialog } = useBestaetigung();

  return (
    <div className="karte">
      <h2 className="karte-titel">KI-Modelle · Anbieter-Keys</h2>
      <p className="hinweis-text">
        Mit einem eigenen Key gehen Aufrufe an Modelle dieses Anbieters direkt an ihn statt
        ueber das AI Gateway. Der Key wird verschluesselt gespeichert und nie wieder im
        Klartext angezeigt. Ohne Key laufen alle Modelle weiter ueber das Gateway.
      </p>

      {!secretKonfiguriert && (
        <div className="meldung">
          <b>PROVIDER_KEY_SECRET ist nicht gesetzt.</b> Ohne dieses Geheimnis koennen Keys
          nicht verschluesselt und deshalb nicht gespeichert werden. Wert erzeugen mit{" "}
          <code>openssl rand -base64 32</code>, in Vercel hinterlegen und neu deployen. Der
          Modellkatalog funktioniert unabhaengig davon mit Gateway-Modellen.
        </div>
      )}

      <div className="formular-raster">
        {KEY_ANBIETER.map((provider) => (
          <KeyFeld
            key={provider}
            provider={provider}
            status={keyStatus[provider]}
            gesperrt={gesperrt || !secretKonfiguriert}
            onSpeichern={(key) => onKeySpeichern(provider, key)}
            onLoeschen={async () => {
              const ja = await bestaetige({
                titel: `Key fuer ${ANBIETER_LABEL[provider]} entfernen?`,
                text: "Modelle dieses Anbieters laufen danach wieder ueber das AI Gateway.",
                bestaetigen: "Entfernen",
              });
              if (ja) void onKeyLoeschen(provider);
            }}
          />
        ))}
      </div>

      {dialog}
    </div>
  );
}

function KeyFeld({
  provider,
  status,
  gesperrt,
  onSpeichern,
  onLoeschen,
}: {
  provider: KeyAnbieter;
  status: KeyStatusUebersicht[KeyAnbieter];
  gesperrt: boolean;
  onSpeichern: (key: string) => Promise<boolean>;
  onLoeschen: () => void;
}) {
  const [eingabe, setEingabe] = useState("");
  const [testModell, setTestModell] = useState("");
  const [testet, setTestet] = useState(false);
  const [testErgebnis, setTestErgebnis] = useState<{ ok: boolean; text: string } | null>(null);

  async function teste() {
    setTestet(true);
    setTestErgebnis(null);
    try {
      const daten = await anfrage<{ modelId: string }>("/api/admin/provider-keys/test", "POST", {
        provider,
        key: eingabe || undefined,
        modelId: testModell || undefined,
      });
      setTestErgebnis({
        ok: true,
        text: `Verbindung zu ${ANBIETER_LABEL[provider]} mit „${daten.modelId}" erfolgreich.`,
      });
    } catch (error) {
      setTestErgebnis({ ok: false, text: fehlerText(error) });
    } finally {
      setTestet(false);
    }
  }

  return (
    <div className="feld">
      <label htmlFor={`key-${provider}`}>{ANBIETER_LABEL[provider]}</label>
      <input
        id={`key-${provider}`}
        type="password"
        value={eingabe}
        disabled={gesperrt}
        onChange={(e) => setEingabe(e.target.value)}
        placeholder={
          status ? `Hinterlegt: ${status.masked} — zum Ersetzen eingeben` : KEY_PLATZHALTER[provider]
        }
        autoComplete="off"
        spellCheck={false}
      />
      <div className="zeile-zusatz" style={{ margin: "6px 0 8px" }}>
        {status ? (
          <>
            Hinterlegt: <code>{status.masked}</code> · Stand {datum(status.updatedAt)}
            {!status.lesbar && (
              <>
                {" "}
                · <b>nicht entschluesselbar</b> — wurde PROVIDER_KEY_SECRET geaendert? Bitte neu
                eingeben.
              </>
            )}
          </>
        ) : (
          "Kein Key hinterlegt — Modelle dieses Anbieters laufen ueber das Gateway."
        )}
      </div>
      <div className="knopfzeile" style={{ alignItems: "center" }}>
        <button
          className="knopf-schlicht"
          disabled={gesperrt || !eingabe.trim()}
          onClick={async () => {
            if (await onSpeichern(eingabe)) {
              setEingabe("");
              setTestErgebnis(null);
            }
          }}
        >
          {status ? "Ersetzen" : "Speichern"}
        </button>
        {status && (
          <button className="knopf-schlicht" disabled={gesperrt} onClick={onLoeschen}>
            Entfernen
          </button>
        )}
        <button
          className="knopf-schlicht"
          disabled={gesperrt || testet || (!status && !eingabe.trim())}
          onClick={() => void teste()}
        >
          {testet ? "Prueft …" : "Verbindung testen"}
        </button>
        <input
          type="text"
          className="feld-schmal"
          style={{ width: 220 }}
          value={testModell}
          disabled={gesperrt}
          onChange={(e) => setTestModell(e.target.value)}
          placeholder="Modell fuer den Test (optional)"
          aria-label={`Modellkennung fuer den Verbindungstest mit ${ANBIETER_LABEL[provider]}`}
        />
      </div>
      {testErgebnis && (
        <div
          className={testErgebnis.ok ? "meldung meldung-neutral" : "meldung"}
          style={{ marginTop: 10, marginBottom: 0 }}
        >
          {testErgebnis.text}
        </div>
      )}
    </div>
  );
}

// --- Modellkatalog ------------------------------------------------------------

type ModellFormular = ModellEingabe;

function eintragZuFormular(eintrag: KatalogEintrag): ModellFormular {
  return {
    id: eintrag.id,
    provider: eintrag.provider,
    label: eintrag.label,
    inputPerMillion: eintrag.inputPerMillion,
    outputPerMillion: eintrag.outputPerMillion,
    cacheReadPerMillion: eintrag.cacheReadPerMillion,
    enabled: eintrag.enabled,
    sortOrder: eintrag.sortOrder,
  };
}

function KatalogKarte({
  katalog,
  keyStatus,
  gesperrt,
  onModellSpeichern,
  onModellLoeschen,
}: KatalogAktionen & Pick<Eigenschaften, "katalog" | "keyStatus" | "gesperrt">) {
  const [entwuerfe, setEntwuerfe] = useState<Record<string, ModellFormular>>({});
  const [neues, setNeues] = useState<ModellFormular | null>(null);
  const { bestaetige, dialog } = useBestaetigung();

  const [quelle, setQuelle] = useState<Anbieter>("gateway");
  const [laedt, setLaedt] = useState(false);
  const [angebot, setAngebot] = useState<VerfuegbaresModell[] | null>(null);
  const [angebotFehler, setAngebotFehler] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const naechsteSortierung = katalog.reduce((max, m) => Math.max(max, m.sortOrder), 0) + 1;

  function entwurf(eintrag: KatalogEintrag): ModellFormular {
    return entwuerfe[eintrag.id] ?? eintragZuFormular(eintrag);
  }

  function aendere(id: string, teil: Partial<ModellFormular>) {
    setEntwuerfe((bisher) => {
      const grundlage =
        bisher[id] ?? eintragZuFormular(katalog.find((eintrag) => eintrag.id === id)!);
      return { ...bisher, [id]: { ...grundlage, ...teil } };
    });
  }

  async function ladeAngebot() {
    setLaedt(true);
    setAngebotFehler(null);
    setAngebot(null);
    try {
      const daten = await anfrage<{ modelle: VerfuegbaresModell[] }>(
        `/api/admin/models/verfuegbar?provider=${quelle}`,
        "GET",
      );
      setAngebot(daten.modelle);
    } catch (error) {
      setAngebotFehler(fehlerText(error));
    } finally {
      setLaedt(false);
    }
  }

  async function uebernimm(modell: VerfuegbaresModell) {
    const werte: ModellFormular = {
      id: modell.id,
      provider: modell.provider,
      label: modell.label.slice(0, 80),
      inputPerMillion: modell.inputPerMillion,
      outputPerMillion: modell.outputPerMillion,
      cacheReadPerMillion: modell.cacheReadPerMillion,
      // Ohne Preis erst einmal inaktiv: Der Server lehnt „aktiv" ohne Preise ab.
      enabled: modell.preisGefunden,
      sortOrder: naechsteSortierung,
    };
    await onModellSpeichern(werte);
  }

  const imKatalog = new Set(katalog.map((eintrag) => eintrag.id));
  const gefiltert = (angebot ?? []).filter(
    (modell) =>
      !filter.trim() ||
      modell.id.toLowerCase().includes(filter.trim().toLowerCase()) ||
      modell.label.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="karte">
      <h2 className="karte-titel">KI-Modelle · Katalog</h2>
      <p className="hinweis-text">
        Nur aktive Modelle stehen den Plaenen zur Auswahl. Die Preise (US-Dollar je 1 Mio.
        Token) sind die Grundlage der Kostenrechnung im Verbrauch — ohne Eingabe- und
        Ausgabepreis laesst sich ein Modell nicht aktiv setzen. Der Anbieter entscheidet, wohin
        der Aufruf geht: <b>direkt</b> braucht einen hinterlegten Key, sonst faellt das Modell
        auf das Gateway zurueck.
      </p>

      <div className="tabelle-huelle">
        <table>
          <thead>
            <tr>
              <th>Kennung</th>
              <th>Anbieter</th>
              <th>Bezeichnung</th>
              <th className="zahl">Eingabe $/Mio.</th>
              <th className="zahl">Ausgabe $/Mio.</th>
              <th className="zahl">Cache $/Mio.</th>
              <th className="zahl">Sort.</th>
              <th>Aktiv</th>
              <th>Anbindung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {katalog.map((eintrag) => {
              const werte = entwurf(eintrag);
              const preiseFehlen = werte.inputPerMillion <= 0 || werte.outputPerMillion <= 0;
              return (
                <tr key={eintrag.id}>
                  <td>
                    <code>{eintrag.id}</code>
                    {eintrag.plaene.length > 0 && (
                      <div className="zeile-zusatz">Plan {eintrag.plaene.join(", ")}</div>
                    )}
                  </td>
                  <td>
                    <AnbieterAuswahl
                      wert={werte.provider}
                      onAendern={(provider) => aendere(eintrag.id, { provider })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="feld-schmal"
                      value={werte.label}
                      maxLength={80}
                      onChange={(e) => aendere(eintrag.id, { label: e.target.value })}
                    />
                  </td>
                  <PreisZelle
                    wert={werte.inputPerMillion}
                    onAendern={(v) => aendere(eintrag.id, { inputPerMillion: v })}
                  />
                  <PreisZelle
                    wert={werte.outputPerMillion}
                    onAendern={(v) => aendere(eintrag.id, { outputPerMillion: v })}
                  />
                  <PreisZelle
                    wert={werte.cacheReadPerMillion}
                    onAendern={(v) => aendere(eintrag.id, { cacheReadPerMillion: v })}
                  />
                  <td className="zahl">
                    <input
                      type="number"
                      className="feld-zahl"
                      style={{ width: 64 }}
                      value={werte.sortOrder}
                      min={0}
                      onChange={(e) => aendere(eintrag.id, { sortOrder: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={werte.enabled}
                      disabled={!werte.enabled && preiseFehlen}
                      title={
                        !werte.enabled && preiseFehlen
                          ? "Erst Eingabe- und Ausgabepreis eintragen."
                          : undefined
                      }
                      aria-label={`${eintrag.id} aktiv`}
                      onChange={(e) => aendere(eintrag.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>{anbindung(werte.provider, keyStatus)}</td>
                  <td className="zahl">
                    <button
                      className="knopf-schlicht"
                      disabled={gesperrt}
                      onClick={() => void onModellSpeichern(werte)}
                    >
                      Speichern
                    </button>{" "}
                    <button
                      className="knopf-schlicht"
                      disabled={gesperrt || eintrag.plaene.length > 0}
                      title={
                        eintrag.plaene.length > 0
                          ? `Wird von Plan ${eintrag.plaene.join(", ")} genutzt.`
                          : undefined
                      }
                      onClick={async () => {
                        const ja = await bestaetige({
                          titel: `Modell "${eintrag.id}" entfernen?`,
                          text: "Der Eintrag verschwindet aus dem Katalog. Kein Plan nutzt ihn derzeit.",
                          bestaetigen: "Loeschen",
                        });
                        if (ja) void onModellLoeschen(eintrag.id);
                      }}
                    >
                      Loeschen
                    </button>
                  </td>
                </tr>
              );
            })}

            {neues && (
              <tr>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="anbieter/modell"
                    value={neues.id}
                    onChange={(e) => setNeues({ ...neues, id: e.target.value })}
                  />
                </td>
                <td>
                  <AnbieterAuswahl
                    wert={neues.provider}
                    onAendern={(provider) => setNeues({ ...neues, provider })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="Bezeichnung"
                    value={neues.label}
                    maxLength={80}
                    onChange={(e) => setNeues({ ...neues, label: e.target.value })}
                  />
                </td>
                <PreisZelle
                  wert={neues.inputPerMillion}
                  onAendern={(v) => setNeues({ ...neues, inputPerMillion: v })}
                />
                <PreisZelle
                  wert={neues.outputPerMillion}
                  onAendern={(v) => setNeues({ ...neues, outputPerMillion: v })}
                />
                <PreisZelle
                  wert={neues.cacheReadPerMillion}
                  onAendern={(v) => setNeues({ ...neues, cacheReadPerMillion: v })}
                />
                <td className="zahl">
                  <input
                    type="number"
                    className="feld-zahl"
                    style={{ width: 64 }}
                    value={neues.sortOrder}
                    min={0}
                    onChange={(e) => setNeues({ ...neues, sortOrder: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={neues.enabled}
                    aria-label="Neues Modell aktiv"
                    onChange={(e) => setNeues({ ...neues, enabled: e.target.checked })}
                  />
                </td>
                <td>{anbindung(neues.provider, keyStatus)}</td>
                <td className="zahl">
                  <button
                    className="knopf-schlicht"
                    disabled={gesperrt}
                    onClick={async () => {
                      if (await onModellSpeichern(neues)) setNeues(null);
                    }}
                  >
                    Anlegen
                  </button>{" "}
                  <button className="knopf-schlicht" onClick={() => setNeues(null)}>
                    Abbrechen
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!neues && (
        <button
          className="knopf-schlicht"
          style={{ marginTop: 14 }}
          onClick={() =>
            setNeues({
              id: "",
              provider: "gateway",
              label: "",
              inputPerMillion: 0,
              outputPerMillion: 0,
              cacheReadPerMillion: 0,
              enabled: false,
              sortOrder: naechsteSortierung,
            })
          }
        >
          Eigene Kennung eintragen
        </button>
      )}

      <div className="anlegen">
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>Modelle vom Anbieter laden</h3>
        <p className="hinweis-text">
          Liste der Modelle, die der Anbieter fuer den hinterlegten Key freigibt (Anthropic,
          OpenAI) bzw. die Sprachmodelle des Gateway-Katalogs. Die Preise werden aus dem
          oeffentlichen Gateway-Katalog vorbelegt; fehlt dort ein Treffer, bleibt der Preis 0
          und das Modell wird inaktiv aufgenommen.
        </p>

        <div className="knopfzeile" style={{ alignItems: "center", marginBottom: 12 }}>
          <select
            value={quelle}
            style={{ width: "auto" }}
            onChange={(e) => {
              setQuelle(e.target.value as Anbieter);
              setAngebot(null);
              setAngebotFehler(null);
            }}
            aria-label="Anbieter, dessen Modelle geladen werden"
          >
            {ANBIETER.map((provider) => (
              <option key={provider} value={provider}>
                {ANBIETER_LABEL[provider]}
                {provider !== "gateway" && !keyStatus[provider] ? " (kein Key)" : ""}
              </option>
            ))}
          </select>
          <button
            className="knopf-schlicht"
            disabled={laedt || (quelle !== "gateway" && !keyStatus[quelle])}
            onClick={() => void ladeAngebot()}
          >
            {laedt ? "Laedt …" : "Modelle laden"}
          </button>
          {angebot && (
            <input
              type="text"
              className="feld-schmal"
              style={{ width: 240 }}
              value={filter}
              placeholder="Liste filtern …"
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>

        {angebotFehler && <div className="meldung">{angebotFehler}</div>}

        {angebot && angebot.length === 0 && (
          <p className="hinweis-text">Der Anbieter hat keine Chat-Modelle fuer diesen Key gemeldet.</p>
        )}

        {angebot && angebot.length > 0 && (
          <div className="tabelle-huelle" style={{ maxHeight: 360, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Kennung</th>
                  <th>Bezeichnung</th>
                  <th className="zahl">Eingabe $/Mio.</th>
                  <th className="zahl">Ausgabe $/Mio.</th>
                  <th className="zahl">Cache $/Mio.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {gefiltert.map((modell) => (
                  <tr key={modell.id}>
                    <td>
                      <code>{modell.id}</code>
                    </td>
                    <td>{modell.label}</td>
                    {modell.preisGefunden ? (
                      <>
                        <td className="zahl">{preis(modell.inputPerMillion)}</td>
                        <td className="zahl">{preis(modell.outputPerMillion)}</td>
                        <td className="zahl">{preis(modell.cacheReadPerMillion)}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="zeile-zusatz">
                        kein Preis im Gateway-Katalog — nach dem Hinzufuegen eintragen
                      </td>
                    )}
                    <td className="zahl">
                      <button
                        className="knopf-schlicht"
                        disabled={gesperrt || imKatalog.has(modell.id)}
                        onClick={() => void uebernimm(modell)}
                      >
                        {imKatalog.has(modell.id) ? "Im Katalog" : "Hinzufuegen"}
                      </button>
                    </td>
                  </tr>
                ))}
                {gefiltert.length === 0 && (
                  <tr>
                    <td colSpan={6} className="hinweis-text" style={{ margin: 0 }}>
                      Kein Modell passt zum Filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog}
    </div>
  );
}

function AnbieterAuswahl({
  wert,
  onAendern,
}: {
  wert: Anbieter;
  onAendern: (wert: Anbieter) => void;
}) {
  return (
    <select value={wert} onChange={(e) => onAendern(e.target.value as Anbieter)}>
      {ANBIETER.map((provider) => (
        <option key={provider} value={provider}>
          {provider === "gateway" ? ANBIETER_LABEL[provider] : `${ANBIETER_LABEL[provider]} (direkt)`}
        </option>
      ))}
    </select>
  );
}

function PreisZelle({
  wert,
  onAendern,
}: {
  wert: number;
  onAendern: (wert: number) => void;
}) {
  return (
    <td className="zahl">
      <input
        type="number"
        className="feld-zahl"
        value={wert}
        min={0}
        step="0.01"
        onChange={(e) => onAendern(Number(e.target.value))}
      />
    </td>
  );
}

/** Wohin ein Aufruf mit dieser Einstellung tatsaechlich geht. */
function anbindung(provider: Anbieter, keyStatus: KeyStatusUebersicht): string {
  if (provider === "gateway") return "Gateway";
  return keyStatus[provider]?.lesbar ? "direkt" : "Gateway (kein Key)";
}

function preis(wert: number): string {
  return wert.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function datum(wert: string): string {
  return new Date(wert).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
