"use client";

import { useOptimistic, useState, useTransition } from "react";
import {
  aendereNutzerAktion,
  erstelleEinladungAktion,
  loeschePlanAktion,
  loescheModellAktion,
  loescheProviderKeyAktion,
  speichereGroessenklasseAktion,
  speichereModellAktion,
  speicherePlanAktion,
  speichereProviderKeyAktion,
  widerrufeEinladungAktion,
} from "@/app/admin/actions";
import { useBestaetigung } from "@/components/BestaetigungsDialog";
import EinladungenKarte from "@/components/EinladungenKarte";
import ModelleKarte from "@/components/ModelleKarte";
import type {
  KatalogEintrag,
  NutzerAenderung,
  NutzerSeite,
  NutzerZeile,
  PlanMitKlasse,
  VerbrauchUebersicht,
} from "@/lib/admin";
import type { AktionsErgebnis } from "@/lib/aktionen";
import type { SizeClass } from "@/lib/db/schema";
import type { Einladung } from "@/lib/einladungen";
import type { ModelInfo } from "@/lib/models";
import type { KeyStatusUebersicht } from "@/lib/provider-keys";

/**
 * Administration: Groessenklassen, Plaene, KI-Modelle, Einladungen, Nutzer, Verbrauch.
 *
 * Bewusst tabellarisch und ohne Bearbeitungsdialoge: Der Admin vergleicht hier
 * Werte zwischen den Klassen ("wie viel mehr ist L als M?"), und dafuer muessen
 * sie gleichzeitig sichtbar sein. Ein Bearbeitungsdialog wuerde genau das
 * verdecken. Nur Loeschbestaetigungen laufen ueber einen Dialog.
 *
 * Speichern geht ueber Server Actions (app/admin/actions.ts): Ein Roundtrip
 * schreibt und liefert die neu gerenderte Seite zurueck. Frueher waren es zwei
 * — fetch gegen die API, dann router.refresh() — und dazwischen stand die
 * Konsole eine Sekunde lang gesperrt.
 */

/** Fuehrt eine Action aus und liefert true bei Erfolg — Karten schliessen damit ihre Formulare. */
export type Ausfuehren = <T>(aktion: () => Promise<AktionsErgebnis<T>>) => Promise<boolean>;

const EIN_MB = 1024 * 1024;

type Eigenschaften = {
  groessenklassen: SizeClass[];
  plaene: PlanMitKlasse[];
  nutzer: NutzerSeite;
  verbrauch: VerbrauchUebersicht;
  /** Aktive Katalogmodelle — die Auswahl fuer die Plaene. */
  modelle: ModelInfo[];
  /** Der ganze Katalog fuer den Abschnitt KI-Modelle. */
  katalog: KatalogEintrag[];
  keyStatus: KeyStatusUebersicht;
  secretKonfiguriert: boolean;
  /** Offene Clerk-Einladungen; null, wenn Clerk sie nicht liefern konnte. */
  einladungen: Einladung[] | null;
  suche: string;
};

export default function AdminKonsole({
  groessenklassen,
  plaene,
  nutzer,
  verbrauch,
  modelle,
  katalog,
  keyStatus,
  secretKonfiguriert,
  einladungen,
  suche,
}: Eigenschaften) {
  const [laueft, starte] = useTransition();
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);

  // Innerhalb der Transition, damit React das mitgelieferte RSC-Payload als
  // Teil derselben Aktualisierung einspielt und `laueft` genau den einen
  // Roundtrip abdeckt.
  const fuehreAus: Ausfuehren = (aktion) => {
    setFehler(null);
    setHinweis(null);
    return new Promise((loese) => {
      starte(async () => {
        try {
          const ergebnis = await aktion();
          if (ergebnis.ok) setHinweis("Gespeichert.");
          else setFehler(ergebnis.fehler);
          loese(ergebnis.ok);
        } catch (error) {
          setFehler(error instanceof Error ? error.message : "Unbekannter Fehler.");
          loese(false);
        }
      });
    });
  };

  return (
    <>
      {fehler && <div className="meldung">{fehler}</div>}
      {hinweis && !fehler && <div className="meldung meldung-neutral">{hinweis}</div>}

      <Kennzahlen verbrauch={verbrauch} />

      <GroessenklassenKarte
        klassen={groessenklassen}
        gesperrt={laueft}
        onSpeichern={(werte) => fuehreAus(() => speichereGroessenklasseAktion(werte))}
      />

      <PlaeneKarte
        plaene={plaene}
        klassen={groessenklassen}
        modelle={modelle}
        gesperrt={laueft}
        onSpeichern={(werte) => fuehreAus(() => speicherePlanAktion(werte))}
        onLoeschen={(id) => fuehreAus(() => loeschePlanAktion(id))}
      />

      <ModelleKarte
        katalog={katalog}
        keyStatus={keyStatus}
        secretKonfiguriert={secretKonfiguriert}
        gesperrt={laueft}
        onKeySpeichern={(provider, key) =>
          fuehreAus(() => speichereProviderKeyAktion({ provider, key }))
        }
        onKeyLoeschen={(provider) => fuehreAus(() => loescheProviderKeyAktion(provider))}
        onModellSpeichern={(werte) => fuehreAus(() => speichereModellAktion(werte))}
        onModellLoeschen={(id) => fuehreAus(() => loescheModellAktion(id))}
      />

      <EinladungenKarte
        einladungen={einladungen}
        plaene={plaene}
        gesperrt={laueft}
        onEinladen={(email, planId) => erstelleEinladungAktion({ email, planId })}
        onWiderrufen={(id) => fuehreAus(() => widerrufeEinladungAktion(id))}
      />

      <NutzerKarte
        seite={nutzer}
        plaene={plaene}
        suche={suche}
        onAendern={(werte) => fuehreAus(() => aendereNutzerAktion(werte))}
      />

      <VielnutzerKarte verbrauch={verbrauch} />
    </>
  );
}

// --- Kennzahlen -------------------------------------------------------------

function Kennzahlen({ verbrauch }: { verbrauch: VerbrauchUebersicht }) {
  return (
    <div className="karte">
      <h1 className="karte-titel">Verbrauch</h1>
      <p className="hinweis-text">
        Die Modellrechnung ist bei dieser Anwendung der groesste Betriebsposten. Diese
        Zahlen sind die Kontrolle darueber.
      </p>

      <div className="kennzahlen">
        <Kennzahl beschriftung="Fragen heute" wert={verbrauch.fragenHeute.toLocaleString("de-DE")} />
        <Kennzahl beschriftung="Kosten heute" wert={geld(verbrauch.kostenHeuteMicros)} />
        <Kennzahl
          beschriftung="Fragen (30 Tage)"
          wert={verbrauch.fragen30Tage.toLocaleString("de-DE")}
        />
        <Kennzahl beschriftung="Kosten (30 Tage)" wert={geld(verbrauch.kosten30TageMicros)} />
      </div>
    </div>
  );
}

function Kennzahl({ beschriftung, wert }: { beschriftung: string; wert: string }) {
  return (
    <div className="kennzahl">
      <div className="kennzahl-wert">{wert}</div>
      <div className="kennzahl-beschriftung">{beschriftung}</div>
    </div>
  );
}

// --- Groessenklassen --------------------------------------------------------

type KlasseFormular = {
  id: string;
  label: string;
  rank: number;
  maxDocuments: number;
  maxPagesPerDocument: number;
  maxTotalPages: number;
  maxFileMegabytes: number;
};

function klasseZuFormular(klasse: SizeClass): KlasseFormular {
  return {
    id: klasse.id,
    label: klasse.label,
    rank: klasse.rank,
    maxDocuments: klasse.maxDocuments,
    maxPagesPerDocument: klasse.maxPagesPerDocument,
    maxTotalPages: klasse.maxTotalPages,
    maxFileMegabytes: Math.round(klasse.maxFileBytes / EIN_MB),
  };
}

const LEERE_KLASSE: KlasseFormular = {
  id: "",
  label: "",
  rank: 5,
  maxDocuments: 20,
  maxPagesPerDocument: 100,
  maxTotalPages: 2000,
  maxFileMegabytes: 25,
};

function GroessenklassenKarte({
  klassen,
  gesperrt,
  onSpeichern,
}: {
  klassen: SizeClass[];
  gesperrt: boolean;
  onSpeichern: (werte: KlasseFormular) => Promise<boolean>;
}) {
  const [entwuerfe, setEntwuerfe] = useState<Record<string, KlasseFormular>>({});
  const [neue, setNeue] = useState<KlasseFormular | null>(null);

  function entwurf(klasse: SizeClass): KlasseFormular {
    return entwuerfe[klasse.id] ?? klasseZuFormular(klasse);
  }

  function aendere(id: string, feld: keyof KlasseFormular, wert: string) {
    setEntwuerfe((bisher) => {
      const grundlage =
        bisher[id] ?? klasseZuFormular(klassen.find((klasse) => klasse.id === id)!);
      return {
        ...bisher,
        [id]: { ...grundlage, [feld]: feld === "label" ? wert : Number(wert) },
      };
    });
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">Groessenklassen</h2>
      <p className="hinweis-text">
        Legt fest, wie viel in <b>eine</b> Sammlung hineinpasst. Welche Klassen ein Nutzer
        anlegen darf, entscheidet sein Plan.
      </p>

      <div className="tabelle-huelle">
        <table>
          <thead>
            <tr>
              <th>Kennung</th>
              <th>Bezeichnung</th>
              <th className="zahl">Rang</th>
              <th className="zahl">Dokumente</th>
              <th className="zahl">Seiten/Dok.</th>
              <th className="zahl">Seiten gesamt</th>
              <th className="zahl">MB/Datei</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {klassen.map((klasse) => {
              const werte = entwurf(klasse);
              return (
                <tr key={klasse.id}>
                  <td>
                    <b>{klasse.id}</b>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="feld-schmal"
                      value={werte.label}
                      onChange={(e) => aendere(klasse.id, "label", e.target.value)}
                    />
                  </td>
                  <ZahlZelle
                    wert={werte.rank}
                    onAendern={(v) => aendere(klasse.id, "rank", v)}
                  />
                  <ZahlZelle
                    wert={werte.maxDocuments}
                    onAendern={(v) => aendere(klasse.id, "maxDocuments", v)}
                  />
                  <ZahlZelle
                    wert={werte.maxPagesPerDocument}
                    onAendern={(v) => aendere(klasse.id, "maxPagesPerDocument", v)}
                  />
                  <ZahlZelle
                    wert={werte.maxTotalPages}
                    onAendern={(v) => aendere(klasse.id, "maxTotalPages", v)}
                  />
                  <ZahlZelle
                    wert={werte.maxFileMegabytes}
                    onAendern={(v) => aendere(klasse.id, "maxFileMegabytes", v)}
                  />
                  <td className="zahl">
                    <button
                      className="knopf-schlicht"
                      disabled={gesperrt}
                      onClick={() => void onSpeichern(werte)}
                    >
                      Speichern
                    </button>
                  </td>
                </tr>
              );
            })}

            {neue && (
              <tr>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="XXL"
                    value={neue.id}
                    onChange={(e) => setNeue({ ...neue, id: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="Bezeichnung"
                    value={neue.label}
                    onChange={(e) => setNeue({ ...neue, label: e.target.value })}
                  />
                </td>
                <ZahlZelle wert={neue.rank} onAendern={(v) => setNeue({ ...neue, rank: Number(v) })} />
                <ZahlZelle
                  wert={neue.maxDocuments}
                  onAendern={(v) => setNeue({ ...neue, maxDocuments: Number(v) })}
                />
                <ZahlZelle
                  wert={neue.maxPagesPerDocument}
                  onAendern={(v) => setNeue({ ...neue, maxPagesPerDocument: Number(v) })}
                />
                <ZahlZelle
                  wert={neue.maxTotalPages}
                  onAendern={(v) => setNeue({ ...neue, maxTotalPages: Number(v) })}
                />
                <ZahlZelle
                  wert={neue.maxFileMegabytes}
                  onAendern={(v) => setNeue({ ...neue, maxFileMegabytes: Number(v) })}
                />
                <td className="zahl">
                  <button
                    className="knopf-schlicht"
                    disabled={gesperrt}
                    onClick={async () => {
                      if (await onSpeichern(neue)) setNeue(null);
                    }}
                  >
                    Anlegen
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!neue && (
        <button
          className="knopf-schlicht"
          style={{ marginTop: 14 }}
          onClick={() => setNeue(LEERE_KLASSE)}
        >
          Weitere Groessenklasse
        </button>
      )}
    </div>
  );
}

function ZahlZelle({
  wert,
  onAendern,
}: {
  wert: number;
  onAendern: (wert: string) => void;
}) {
  return (
    <td className="zahl">
      <input
        type="number"
        className="feld-zahl"
        value={wert}
        min={0}
        onChange={(e) => onAendern(e.target.value)}
      />
    </td>
  );
}

// --- Plaene -----------------------------------------------------------------

type PlanFormular = {
  id: string;
  label: string;
  maxSizeClassId: string;
  maxCollections: number;
  maxQuestionsPerDay: number;
  modelId: string;
  isDefault: boolean;
};

function planZuFormular(plan: PlanMitKlasse): PlanFormular {
  return {
    id: plan.id,
    label: plan.label,
    maxSizeClassId: plan.maxSizeClassId,
    maxCollections: plan.maxCollections,
    maxQuestionsPerDay: plan.maxQuestionsPerDay,
    modelId: plan.modelId,
    isDefault: plan.isDefault,
  };
}

function PlaeneKarte({
  plaene,
  klassen,
  modelle,
  gesperrt,
  onSpeichern,
  onLoeschen,
}: {
  plaene: PlanMitKlasse[];
  klassen: SizeClass[];
  modelle: ModelInfo[];
  gesperrt: boolean;
  onSpeichern: (werte: PlanFormular) => Promise<boolean>;
  onLoeschen: (id: string) => Promise<boolean>;
}) {
  const [entwuerfe, setEntwuerfe] = useState<Record<string, PlanFormular>>({});
  const [neuer, setNeuer] = useState<PlanFormular | null>(null);
  const { bestaetige, dialog } = useBestaetigung();

  function aendere(id: string, teil: Partial<PlanFormular>) {
    setEntwuerfe((bisher) => {
      const grundlage =
        bisher[id] ?? planZuFormular(plaene.find((plan) => plan.id === id)!);
      return { ...bisher, [id]: { ...grundlage, ...teil } };
    });
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">Plaene</h2>
      <p className="hinweis-text">
        Ein Plan wird einem Nutzer zugewiesen. Er entscheidet, bis zu welcher
        Groessenklasse dieser Sammlungen anlegen darf, wie viele, und wie viele Fragen er
        pro Tag stellen kann. Das Tageskontingent ist die wirksamste Bremse gegen eine
        aus dem Ruder laufende Modellrechnung. Zur Auswahl stehen die aktiven Modelle des
        Katalogs (Abschnitt KI-Modelle).
      </p>

      <div className="tabelle-huelle">
        <table>
          <thead>
            <tr>
              <th>Kennung</th>
              <th>Bezeichnung</th>
              <th>Bis Groessenklasse</th>
              <th className="zahl">Sammlungen</th>
              <th className="zahl">Fragen/Tag</th>
              <th>Modell</th>
              <th>Standard</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plaene.map((plan) => {
              const werte = entwuerfe[plan.id] ?? planZuFormular(plan);
              return (
                <tr key={plan.id}>
                  <td>
                    <b>{plan.id}</b>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="feld-schmal"
                      value={werte.label}
                      onChange={(e) => aendere(plan.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={werte.maxSizeClassId}
                      onChange={(e) => aendere(plan.id, { maxSizeClassId: e.target.value })}
                    >
                      {klassen.map((klasse) => (
                        <option key={klasse.id} value={klasse.id}>
                          {klasse.id}
                        </option>
                      ))}
                    </select>
                  </td>
                  <ZahlZelle
                    wert={werte.maxCollections}
                    onAendern={(v) => aendere(plan.id, { maxCollections: Number(v) })}
                  />
                  <ZahlZelle
                    wert={werte.maxQuestionsPerDay}
                    onAendern={(v) => aendere(plan.id, { maxQuestionsPerDay: Number(v) })}
                  />
                  <td>
                    <select
                      value={werte.modelId}
                      onChange={(e) => aendere(plan.id, { modelId: e.target.value })}
                    >
                      {/* Traegt der Plan ein Modell, das nicht mehr aktiv ist, bleibt es
                          sichtbar — sonst zeigte das Feld still ein anderes an. */}
                      {!modelle.some((modell) => modell.id === werte.modelId) && (
                        <option value={werte.modelId}>{werte.modelId} (nicht im Katalog aktiv)</option>
                      )}
                      {modelle.map((modell) => (
                        <option key={modell.id} value={modell.id}>
                          {modell.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="standardplan"
                      checked={werte.isDefault}
                      onChange={() => aendere(plan.id, { isDefault: true })}
                      aria-label={`${plan.id} als Standardplan`}
                    />
                  </td>
                  <td className="zahl">
                    <button
                      className="knopf-schlicht"
                      disabled={gesperrt}
                      onClick={() => void onSpeichern(werte)}
                    >
                      Speichern
                    </button>{" "}
                    <button
                      className="knopf-schlicht"
                      disabled={gesperrt || plan.isDefault}
                      onClick={async () => {
                        const ja = await bestaetige({
                          titel: `Plan "${plan.id}" loeschen?`,
                          text: "Der Plan wird entfernt. Nutzer, die ihn noch haben, muessen vorher einen anderen Plan bekommen.",
                          bestaetigen: "Loeschen",
                        });
                        if (ja) void onLoeschen(plan.id);
                      }}
                    >
                      Loeschen
                    </button>
                  </td>
                </tr>
              );
            })}

            {neuer && (
              <tr>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="Kennung"
                    value={neuer.id}
                    onChange={(e) => setNeuer({ ...neuer, id: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="feld-schmal"
                    placeholder="Bezeichnung"
                    value={neuer.label}
                    onChange={(e) => setNeuer({ ...neuer, label: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    value={neuer.maxSizeClassId}
                    onChange={(e) => setNeuer({ ...neuer, maxSizeClassId: e.target.value })}
                  >
                    {klassen.map((klasse) => (
                      <option key={klasse.id} value={klasse.id}>
                        {klasse.id}
                      </option>
                    ))}
                  </select>
                </td>
                <ZahlZelle
                  wert={neuer.maxCollections}
                  onAendern={(v) => setNeuer({ ...neuer, maxCollections: Number(v) })}
                />
                <ZahlZelle
                  wert={neuer.maxQuestionsPerDay}
                  onAendern={(v) => setNeuer({ ...neuer, maxQuestionsPerDay: Number(v) })}
                />
                <td>
                  <select
                    value={neuer.modelId}
                    onChange={(e) => setNeuer({ ...neuer, modelId: e.target.value })}
                  >
                    {modelle.map((modell) => (
                      <option key={modell.id} value={modell.id}>
                        {modell.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td />
                <td className="zahl">
                  <button
                    className="knopf-schlicht"
                    disabled={gesperrt}
                    onClick={async () => {
                      if (await onSpeichern(neuer)) setNeuer(null);
                    }}
                  >
                    Anlegen
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!neuer && klassen.length > 0 && (
        <button
          className="knopf-schlicht"
          style={{ marginTop: 14 }}
          onClick={() =>
            setNeuer({
              id: "",
              label: "",
              maxSizeClassId: klassen[0].id,
              maxCollections: 3,
              maxQuestionsPerDay: 200,
              modelId: modelle[0]?.id ?? "",
              isDefault: false,
            })
          }
        >
          Weiterer Plan
        </button>
      )}

      {dialog}
    </div>
  );
}

// --- Nutzer -----------------------------------------------------------------

function NutzerKarte({
  seite,
  plaene,
  suche,
  onAendern,
}: {
  seite: NutzerSeite;
  plaene: PlanMitKlasse[];
  suche: string;
  onAendern: (werte: NutzerAenderung) => Promise<boolean>;
}) {
  const [begriff, setBegriff] = useState(suche);
  const [, starte] = useTransition();

  // Select und Checkbox sind aus den Props gesteuert. Ohne diesen Schritt
  // spraengen sie nach dem Klick auf den alten Wert zurueck, bis die Antwort
  // da ist. useOptimistic zeigt den neuen Wert sofort und faellt nach Ende der
  // Transition von selbst auf die Props zurueck — bei Erfolg tragen die den
  // Wert dann selbst, bei einem Fehler steht wieder der alte da.
  const [zeilen, zeigeSofort] = useOptimistic(
    seite.zeilen,
    (bisher: NutzerZeile[], aenderung: NutzerAenderung) =>
      bisher.map((zeile) =>
        zeile.clerkUserId === aenderung.clerkUserId
          ? {
              ...zeile,
              ...(aenderung.planId !== undefined ? { planId: aenderung.planId } : {}),
              ...(aenderung.isAdmin !== undefined ? { isAdmin: aenderung.isAdmin } : {}),
            }
          : zeile,
      ),
  );

  function aendere(aenderung: NutzerAenderung) {
    starte(async () => {
      zeigeSofort(aenderung);
      await onAendern(aenderung);
    });
  }

  function suchen(neuerBegriff: string) {
    const ziel = new URL(window.location.href);
    if (neuerBegriff) ziel.searchParams.set("suche", neuerBegriff);
    else ziel.searchParams.delete("suche");
    ziel.searchParams.delete("seite");
    window.location.href = ziel.toString();
  }

  function blaettern(zielSeite: number) {
    const ziel = new URL(window.location.href);
    ziel.searchParams.set("seite", String(zielSeite));
    window.location.href = ziel.toString();
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">
        Nutzer{" "}
        <span className="karte-zusatz">
          · {seite.gesamt.toLocaleString("de-DE")}{" "}
          {seite.gesamt === 1 ? "Konto" : "Konten"}
        </span>
      </h2>

      <div className="suchzeile">
        <input
          type="text"
          value={begriff}
          placeholder="Nach E-Mail, Name oder Nutzer-ID suchen …"
          onChange={(e) => setBegriff(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") suchen(begriff);
          }}
        />
        <button className="knopf-schlicht" onClick={() => suchen(begriff)}>
          Suchen
        </button>
      </div>

      <div className="tabelle-huelle">
        <table>
          <thead>
            <tr>
              <th>Konto</th>
              <th>Plan</th>
              <th className="zahl">Sammlungen</th>
              <th className="zahl">Dokumente</th>
              <th className="zahl">Angemeldet seit</th>
              <th>Admin</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((zeile) => (
              <tr key={zeile.clerkUserId}>
                <td>
                  <div>{zeile.email ?? "(keine E-Mail)"}</div>
                  {zeile.name && <div className="zeile-zusatz">{zeile.name}</div>}
                </td>
                <td>
                  <select
                    value={zeile.planId}
                    onChange={(e) =>
                      aendere({ clerkUserId: zeile.clerkUserId, planId: e.target.value })
                    }
                  >
                    {plaene.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="zahl">{zeile.collectionCount}</td>
                <td className="zahl">{zeile.documentCount}</td>
                <td className="zahl">{datum(zeile.createdAt)}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={zeile.isAdmin}
                    aria-label={`Administrationsrechte fuer ${zeile.email ?? zeile.clerkUserId}`}
                    onChange={(e) =>
                      aendere({ clerkUserId: zeile.clerkUserId, isAdmin: e.target.checked })
                    }
                  />
                </td>
              </tr>
            ))}

            {zeilen.length === 0 && (
              <tr>
                <td colSpan={6} className="hinweis-text" style={{ margin: 0 }}>
                  Keine Konten gefunden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {seite.seiten > 1 && (
        <div className="blaetterleiste">
          <button
            className="knopf-schlicht"
            disabled={seite.seite <= 1}
            onClick={() => blaettern(seite.seite - 1)}
          >
            Zurueck
          </button>
          <span>
            Seite {seite.seite} von {seite.seiten}
          </span>
          <button
            className="knopf-schlicht"
            disabled={seite.seite >= seite.seiten}
            onClick={() => blaettern(seite.seite + 1)}
          >
            Weiter
          </button>
        </div>
      )}
    </div>
  );
}

// --- Vielnutzer -------------------------------------------------------------

function VielnutzerKarte({ verbrauch }: { verbrauch: VerbrauchUebersicht }) {
  if (verbrauch.vielnutzer.length === 0) return null;

  return (
    <div className="karte">
      <h2 className="karte-titel">Groesste Verbraucher (30 Tage)</h2>
      <p className="hinweis-text">
        Wenn die Rechnung ungewoehnlich aussieht, steht die Ursache hier oben.
      </p>

      <div className="tabelle-huelle">
        <table>
          <thead>
            <tr>
              <th>Konto</th>
              <th className="zahl">Fragen</th>
              <th className="zahl">Kosten</th>
            </tr>
          </thead>
          <tbody>
            {verbrauch.vielnutzer.map((zeile) => (
              <tr key={zeile.userId}>
                <td>{zeile.email ?? zeile.userId}</td>
                <td className="zahl">{zeile.fragen.toLocaleString("de-DE")}</td>
                <td className="zahl">{geld(zeile.kostenMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Formatierung -----------------------------------------------------------

/** Mikro-Dollar in eine lesbare Betragsangabe. */
function geld(micros: number): string {
  const dollar = micros / 1_000_000;
  return dollar.toLocaleString("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: dollar < 100 ? 2 : 0,
  });
}

function datum(wert: Date | string): string {
  return new Date(wert).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
