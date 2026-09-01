"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  MAX_DAILY_ANSWER_LIMIT,
  PROVIDERS,
  PROVIDER_LABEL,
  type ModelInfo,
  type Provider,
  type PublicSettings,
} from "@/lib/providers";

type Meldung = { art: "erfolg" | "fehler" | "neutral"; text: string };

/** Pro Anbieter: leerer String = unveraendert, Text = neuer Key, `null` = loeschen. */
type KeyEingaben = Record<Provider, string | null>;

const KEY_PLATZHALTER: Record<Provider, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
};

export default function SettingsCard({
  einstellungen,
  verbrauchHeute,
}: {
  einstellungen: PublicSettings;
  verbrauchHeute: number;
}) {
  const router = useRouter();

  const [gespeichert, setGespeichert] = useState(einstellungen);
  const [provider, setProvider] = useState<Provider>(einstellungen.provider);
  const [modell, setModell] = useState(einstellungen.model);
  const [budget, setBudget] = useState(String(einstellungen.dailyAnswerLimit));
  const [nutzerBudget, setNutzerBudget] = useState(
    einstellungen.dailyAnswerLimitPerUser === null ? "" : String(einstellungen.dailyAnswerLimitPerUser),
  );
  const [keys, setKeys] = useState<KeyEingaben>({ anthropic: "", openai: "" });

  const [modelle, setModelle] = useState<ModelInfo[] | null>(null);
  const [laedtModelle, setLaedtModelle] = useState(false);
  const [testet, setTestet] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [meldung, setMeldung] = useState<Meldung | null>(null);

  const keyStatus = gespeichert.keys[provider];
  const keyEingabe = keys[provider];
  const hatKey = Boolean(keyStatus) || Boolean(keyEingabe);

  const gespeichertesNutzerBudget =
    gespeichert.dailyAnswerLimitPerUser === null ? "" : String(gespeichert.dailyAnswerLimitPerUser);
  const geaendert =
    provider !== gespeichert.provider ||
    modell.trim() !== gespeichert.model ||
    budget !== String(gespeichert.dailyAnswerLimit) ||
    nutzerBudget !== gespeichertesNutzerBudget ||
    PROVIDERS.some((p) => keys[p] !== "");

  function wechsleProvider(neu: Provider) {
    setProvider(neu);
    setModelle(null);
    setMeldung(null);
    // Ein Modell gehoert zu genau einem Anbieter — die ID des alten waere hier falsch.
    setModell(neu === gespeichert.provider ? gespeichert.model : "");
  }

  async function ladeModelle() {
    setLaedtModelle(true);
    setMeldung(null);
    try {
      const daten = await anfrage<{ models: ModelInfo[] }>("/api/settings/models", {
        provider,
        apiKey: keyEingabe || undefined,
      });
      setModelle(daten.models);
      if (daten.models.length === 0) {
        setMeldung({ art: "neutral", text: "Der Anbieter hat keine Chat-Modelle fuer diesen Key gemeldet." });
      } else if (!modell) {
        setModell(daten.models[0].id);
      }
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    } finally {
      setLaedtModelle(false);
    }
  }

  async function teste() {
    setTestet(true);
    setMeldung(null);
    try {
      await anfrage("/api/settings/test", { provider, model: modell, apiKey: keyEingabe || undefined });
      setMeldung({ art: "erfolg", text: `Verbindung zu ${PROVIDER_LABEL[provider]} mit „${modell}" erfolgreich.` });
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    } finally {
      setTestet(false);
    }
  }

  async function speichere() {
    setSpeichert(true);
    setMeldung(null);
    try {
      const keyAenderungen: Partial<Record<Provider, string | null>> = {};
      for (const p of PROVIDERS) {
        if (keys[p] !== "") keyAenderungen[p] = keys[p];
      }

      const daten = await anfrage<{ settings: PublicSettings }>(
        "/api/settings",
        {
          provider,
          model: modell.trim(),
          dailyAnswerLimit: Number(budget),
          dailyAnswerLimitPerUser: nutzerBudget.trim() === "" ? null : Number(nutzerBudget),
          keys: keyAenderungen,
        },
        "PUT",
      );

      setGespeichert(daten.settings);
      setModell(daten.settings.model);
      setBudget(String(daten.settings.dailyAnswerLimit));
      setNutzerBudget(
        daten.settings.dailyAnswerLimitPerUser === null ? "" : String(daten.settings.dailyAnswerLimitPerUser),
      );
      setKeys({ anthropic: "", openai: "" });
      setMeldung({ art: "erfolg", text: "Einstellungen gespeichert." });
      router.refresh();
    } catch (error) {
      setMeldung({ art: "fehler", text: fehlerText(error) });
    } finally {
      setSpeichert(false);
    }
  }

  async function anfrage<T = unknown>(url: string, body: unknown, method = "POST"): Promise<T> {
    const antwort = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (antwort.status === 401) {
      router.push("/login?weiter=/admin");
      throw new Error("Die Sitzung ist abgelaufen. Bitte neu anmelden.");
    }
    const daten = (await antwort.json().catch(() => ({}))) as T & { error?: string };
    if (!antwort.ok) throw new Error(daten.error ?? `Der Server antwortete mit Status ${antwort.status}.`);
    return daten;
  }

  const modellInListe = modelle?.some((m) => m.id === modell) ?? false;

  return (
    <div className="karte">
      <h2 className="karte-titel">Modell und API-Key</h2>
      <p className="hinweis-text">
        Der Chat antwortet mit dem hier gewaehlten Modell. Der API-Key wird verschluesselt
        gespeichert und nie wieder im Klartext angezeigt.
        {gespeichert.model ? (
          <>
            {" "}
            Aktiv: <b>{PROVIDER_LABEL[gespeichert.provider]}</b> · <code>{gespeichert.model}</code>
          </>
        ) : (
          <>
            {" "}
            <b>Noch kein Modell festgelegt — der Chat kann nicht antworten.</b>
          </>
        )}
      </p>

      {meldung && <div className={`meldung meldung-${meldung.art}`}>{meldung.text}</div>}

      <div className="formular-raster">
        <div className="feld">
          <label htmlFor="provider">Anbieter</label>
          <select
            id="provider"
            value={provider}
            onChange={(event) => wechsleProvider(event.target.value as Provider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="feld">
          <label htmlFor="api-key">API-Key ({PROVIDER_LABEL[provider]})</label>
          {keyEingabe === null ? (
            <div className="knopf-reihe">
              <span className="feld-hinweis" style={{ marginTop: 0 }}>
                Wird beim Speichern entfernt.
              </span>
              <button
                className="knopf-schlicht"
                type="button"
                onClick={() => setKeys({ ...keys, [provider]: "" })}
              >
                Doch behalten
              </button>
            </div>
          ) : (
            <>
              <input
                id="api-key"
                type="password"
                value={keyEingabe}
                onChange={(event) => setKeys({ ...keys, [provider]: event.target.value })}
                placeholder={keyStatus ? `Gespeichert: ${keyStatus.masked} — zum Ersetzen eingeben` : KEY_PLATZHALTER[provider]}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="feld-hinweis">
                {keyStatus?.source === "gespeichert" && (
                  <>
                    Hinterlegt: <code>{keyStatus.masked}</code>{" "}
                    <button
                      className="knopf-schlicht"
                      type="button"
                      onClick={() => setKeys({ ...keys, [provider]: null })}
                    >
                      Entfernen
                    </button>
                  </>
                )}
                {keyStatus?.source === "umgebung" && (
                  <>
                    Aus der Umgebungsvariable: <code>{keyStatus.masked}</code>. Ein hier eingegebener
                    Key hat Vorrang.
                  </>
                )}
                {!keyStatus && "Noch kein Key hinterlegt."}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="feld">
        <label htmlFor="modell">Modell</label>
        <div className="knopf-reihe" style={{ marginBottom: 8 }}>
          <button
            className="knopf-schlicht"
            type="button"
            onClick={() => void ladeModelle()}
            disabled={laedtModelle || !hatKey}
            title={hatKey ? undefined : "Zuerst einen API-Key eingeben"}
          >
            {laedtModelle ? "Lade Modelle …" : "Modelle vom Anbieter laden"}
          </button>
          {modelle && modelle.length > 0 && (
            <select
              aria-label="Modell aus Liste waehlen"
              value={modellInListe ? modell : ""}
              onChange={(event) => setModell(event.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            >
              <option value="" disabled>
                Aus {modelle.length} Modellen waehlen …
              </option>
              {modelle.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
            </select>
          )}
        </div>
        <input
          id="modell"
          type="text"
          value={modell}
          onChange={(event) => setModell(event.target.value)}
          placeholder={provider === "anthropic" ? "z. B. claude-sonnet-4-5" : "z. B. gpt-5"}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="feld-hinweis">
          Die Modell-ID laesst sich auch direkt eintragen, etwa fuer Modelle, die der Anbieter
          nicht in der Liste fuehrt.
        </div>
      </div>

      <div className="formular-raster">
        <div className="feld">
          <label htmlFor="budget">Antworten pro Tag (Kostenbremse)</label>
          <input
            id="budget"
            type="number"
            min={1}
            max={MAX_DAILY_ANSWER_LIMIT}
            step={1}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          <div className="feld-hinweis">
            Heute verbraucht: <b>{verbrauchHeute}</b> von {gespeichert.dailyAnswerLimit}. Zaehlt nur
            Fragen, zu denen Fundstellen existieren und das Modell tatsaechlich antwortet.
          </div>
        </div>

        <div className="feld">
          <label htmlFor="nutzer-budget">Antworten pro Nutzer und Tag</label>
          <input
            id="nutzer-budget"
            type="number"
            min={0}
            max={MAX_DAILY_ANSWER_LIMIT}
            step={1}
            value={nutzerBudget}
            onChange={(event) => setNutzerBudget(event.target.value)}
            placeholder="leer = kein eigenes Limit"
          />
          <div className="feld-hinweis">
            Verhindert, dass ein einzelner Nutzer das gemeinsame Tagesbudget aufbraucht. Leer
            oder 0 bedeutet: nur das globale Limit gilt.
          </div>
        </div>
      </div>

      <div className="knopf-reihe">
        <button className="knopf" type="button" onClick={() => void speichere()} disabled={speichert || !geaendert}>
          {speichert ? "Speichert …" : "Einstellungen speichern"}
        </button>
        <button
          className="knopf knopf-sekundaer"
          type="button"
          onClick={() => void teste()}
          disabled={testet || !hatKey || !modell.trim()}
        >
          {testet ? "Prueft …" : "Verbindung testen"}
        </button>
      </div>
    </div>
  );
}

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : "Unbekannter Fehler.";
}
