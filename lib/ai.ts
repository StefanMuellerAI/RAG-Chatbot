import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { gateway, generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { KIND_LABEL, type CollectionSchema } from "./collection-kinds";
import { ladeEigeneSammlungen, type SammlungMitKlasse } from "./collections";
import { sucheModell } from "./modellkatalog";
import {
  ANBIETER_LABEL,
  istKeyAnbieter,
  waehleAnbindung,
  zerlegeKennung,
  type Anbieter,
  type KeyAnbieter,
} from "./models";
import { effektiveVerarbeitung, findPreset } from "./presets";
import { ladeKey } from "./provider-keys";
import { sucheInSammlung, type Hit } from "./vector";

/**
 * Modellzugriff, Systemanweisung und das Werkzeug zur Sammlungsauswahl.
 */

/**
 * Das Sprachmodell zu einer Katalogkennung.
 *
 * Zwei Wege: Nennt der Katalogeintrag Anthropic oder OpenAI als Anbieter UND
 * ist dafuer ein Key hinterlegt, geht der Aufruf direkt an den Anbieter — mit
 * der nativen Kennung hinter dem ersten Schraegstrich. Alles andere laeuft
 * ueber das AI Gateway (Auth: AI_GATEWAY_API_KEY, oder auf Vercel der
 * OIDC-Token aus dem Request-Header `x-vercel-oidc-token`).
 *
 * Auch eine Kennung, die nicht im Katalog steht, geht ans Gateway — etwa das
 * Modell der Werkzeughebung, falls ein Admin es aus dem Katalog genommen hat.
 */
export async function modell(modelId: string): Promise<LanguageModel> {
  const eintrag = await sucheModell(modelId);
  if (!eintrag || !istKeyAnbieter(eintrag.provider)) return gateway(modelId);

  const apiKey = await ladeKey(eintrag.provider);
  if (apiKey === null || waehleAnbindung(eintrag, true) === "gateway") {
    return gateway(modelId);
  }

  return direktesModell(eintrag.provider, zerlegeKennung(modelId).nativeId, apiKey);
}

/** Direkte Anbindung ueber das AI SDK; der Key wird je Aufruf uebergeben. */
export function direktesModell(
  provider: KeyAnbieter,
  nativeId: string,
  apiKey: string,
): LanguageModel {
  return provider === "anthropic"
    ? createAnthropic({ apiKey })(nativeId)
    : createOpenAI({ apiKey })(nativeId);
}

/**
 * Kleinstmoeglicher Aufruf, um Key und Modellkennung zu pruefen. Mit
 * `maxRetries: 0`, damit ein abgelehnter Key sofort als solcher gemeldet wird
 * statt nach drei Wiederholungen.
 */
export async function testeModell(ziel: {
  provider: KeyAnbieter;
  nativeId: string;
  apiKey: string;
}): Promise<{ ok: true } | { ok: false; fehler: string }> {
  try {
    await generateText({
      model: direktesModell(ziel.provider, ziel.nativeId, ziel.apiKey),
      prompt: "Antworte nur mit OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, fehler: beschreibeAnbieterfehler(error, ziel.provider) };
  }
}

/**
 * Uebersetzt SDK-/HTTP-Fehler in einen Satz, mit dem der Admin etwas anfangen
 * kann. Enthaelt nie den Key — nur Status und Anbietername.
 */
export function beschreibeAnbieterfehler(error: unknown, provider: Anbieter): string {
  const label = ANBIETER_LABEL[provider];
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  const meldung = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) return `${label} hat den API-Key abgelehnt.`;
  if (status === 404) return `${label} kennt dieses Modell nicht. Bitte die Modellkennung pruefen.`;
  if (status === 429) return `${label} meldet ein Ratenlimit oder erschoepftes Guthaben.`;
  return `${label}: ${meldung}`;
}

export const SYSTEM_ANWEISUNG = `Du bist der Wissensassistent einer Organisation. Du beantwortest Fragen ausschliesslich auf Grundlage von Auszuegen aus den Dokumentensammlungen des Nutzers.

Regeln:
- Stuetze jede inhaltliche Aussage auf die Auszuege. Nutze kein Allgemeinwissen, um Luecken zu fuellen.
- Belege jede Aussage mit der Nummer des Auszugs in eckigen Klammern, zum Beispiel [1] oder [2][3].
- Wenn die Auszuege die Frage nicht oder nur teilweise beantworten, sage das ausdruecklich. Rate nicht und formuliere nichts Plausibles hinzu.
- Widersprechen sich Auszuege, benenne den Widerspruch, statt dich fuer eine Seite zu entscheiden.
- Antworte auf Deutsch, sachlich und so knapp wie moeglich.
- Deine Antwort wird als Markdown dargestellt. Nutze Absaetze, Aufzaehlungen, Fettung fuer Schluesselbegriffe und Tabellen fuer Gegenueberstellungen, wenn das die Antwort klarer macht. Ueberschriften nur bei wirklich langen Antworten mit mehreren Themen - eine Chatantwort ist kein Dokument.
- Fragen zur Bedienung des Assistenten selbst darfst du direkt beantworten, ohne Beleg.

Zur Suche:
- Du hast Zugriff auf mehrere Sammlungen, die unten aufgelistet sind. Waehle anhand von Name und Beschreibung, welche zur Frage passt.
- Beruehrt eine Frage mehrere Bestaende, gib mehrere Sammlungen in EINEM Aufruf an, statt mehrfach zu suchen.
- Formuliere den Suchbegriff als inhaltliche Suchanfrage, nicht als Frage an dich selbst. Statt "Was kostet ein Reisepass?" also "Gebuehren Reisepass Kosten".
- Findest du nichts, versuche hoechstens einen weiteren Aufruf mit anderen Begriffen. Danach sage, dass die Sammlungen dazu nichts enthalten.`;

/**
 * Zusatzregeln fuer Tabellen- und Graph-Sammlungen.
 *
 * Sie kommen nur in die Systemanweisung, wenn der Nutzer solche Sammlungen
 * hat: Fuer reine Dokumentensammlungen bleibt der Text oben unveraendert, und
 * das Modell wird nicht mit Regeln fuer Werkzeuge belastet, die es gar nicht
 * bekommt.
 */
const REGELN_SQL = `Zu Tabellen-Sammlungen (Werkzeug sql_ausfuehren):
- SQLite-Dialekt. Genau ein SELECT (auch mit WITH), ohne Semikolon, ohne weitere Statements.
- Aggregiere und filtere in SQL, statt viele Zeilen zu lesen. Ergebnisse sind auf 200 Zeilen begrenzt — bei mehr Daten gruppieren oder LIMIT und ORDER BY einsetzen.
- Nutze Tabellen- und Spaltennamen exakt so, wie sie im Katalog stehen (in doppelten Anfuehrungszeichen, falls noetig).`;

const REGELN_CYPHER = `Zu Graph-Sammlungen (Werkzeug cypher_ausfuehren):
- openCypher, wie FalkorDB es versteht. Genau ein MATCH/RETURN-Statement, ohne Semikolon.
- Wenn du Kanten zaehlst, referenziere den Beziehungs-Alias in RETURN oder WHERE.
- Keine Aggregation innerhalb von Pattern-Comprehensions.
- Keine Schreiboperationen (CREATE, MERGE, SET, DELETE, REMOVE).`;

const REGELN_WERKZEUGE = `Zu SQL und Cypher allgemein:
- Schlaegt eine Abfrage fehl, lies die Fehlermeldung, korrigiere die Abfrage und versuche es hoechstens zweimal erneut.
- Nenne in der Antwort, aus welcher Sammlung die Zahlen stammen. Gib sie so wieder, wie sie zurueckkamen; die Belegnummern in eckigen Klammern gelten nur fuer Auszuege aus Dokumenten.`;

/**
 * Systemanweisung fuer den Werkzeugmodus, abhaengig davon, welche Typen von
 * Sammlungen im Spiel sind. Ohne sql- oder graph-Sammlungen ist das Ergebnis
 * exakt SYSTEM_ANWEISUNG.
 */
export function baueSystemanweisung(sammlungen: SammlungMitKlasse[]): string {
  const hatSql = sammlungen.some((sammlung) => sammlung.kind === "sql");
  const hatGraph = sammlungen.some((sammlung) => sammlung.kind === "graph");

  if (!hatSql && !hatGraph) return SYSTEM_ANWEISUNG;

  const bloecke = [SYSTEM_ANWEISUNG];
  if (sammlungen.length === 1) {
    bloecke.push(
      "Es gibt genau eine Sammlung; sie ist im Werkzeug fest eingestellt, eine ID ist nicht noetig.",
    );
  }
  if (hatSql) bloecke.push(REGELN_SQL);
  if (hatGraph) bloecke.push(REGELN_CYPHER);
  bloecke.push(REGELN_WERKZEUGE);

  return bloecke.join("\n\n");
}

/** Mehr Schema-Text je Sammlung wuerde den Prompt bei vielen Tabellen sprengen. */
const SCHEMA_MAX_ZEICHEN = 1_500;

/**
 * Katalog der Sammlungen fuer die Systemanweisung.
 *
 * Dieser Text entscheidet ueber die Qualitaet der Auswahl: Das Modell sieht
 * ausschliesslich Name und Beschreibung, nicht den Inhalt. Eine Sammlung ohne
 * Beschreibung ist fuer die Auswahl praktisch unsichtbar — deshalb wird sie
 * nach der ersten Ingestion automatisch vorgeschlagen.
 *
 * Tabellen- und Graph-Sammlungen bringen zusaetzlich ihr Schema mit: Ohne
 * Tabellen, Spalten und Beispielwerte bzw. Labels und Beziehungstypen kann
 * das Modell keine Abfrage formulieren, die trifft.
 */
export function baueKatalog(sammlungen: SammlungMitKlasse[]): string {
  const zeilen = sammlungen.map((sammlung) => {
    const beschreibung = sammlung.description || "(keine Beschreibung hinterlegt)";
    const kopf =
      `- id: ${sammlung.id}\n` + `  Name: ${sammlung.name}\n` + `  Inhalt: ${beschreibung}\n`;

    if (sammlung.kind === "vector") {
      const preset = findPreset(sammlung.preset);
      return kopf + `  Art: ${preset.label} · ${sammlung.documentCount} Dokumente`;
    }

    const werkzeug = sammlung.kind === "sql" ? "sql_ausfuehren" : "cypher_ausfuehren";
    const schema = beschreibeSchema(sammlung.kind, sammlung.schema)
      .map((zeile) => `  ${zeile}`)
      .join("\n");

    return (
      kopf +
      `  Art: ${KIND_LABEL[sammlung.kind]} (Werkzeug ${werkzeug}) · ${sammlung.documentCount} Dateien\n` +
      kuerze(schema, SCHEMA_MAX_ZEICHEN)
    );
  });

  return `Verfuegbare Sammlungen:\n\n${zeilen.join("\n")}`;
}

/** Schema einer Tabellen- oder Graph-Sammlung als Zeilen fuer den Katalog. */
function beschreibeSchema(
  kind: "sql" | "graph",
  schema: CollectionSchema | null | undefined,
): string[] {
  if (kind === "sql") {
    if (!schema || schema.kind !== "sql" || schema.tables.length === 0) {
      return ["Noch keine Tabellen."];
    }
    return schema.tables.map((tabelle) => {
      const spalten = tabelle.columns
        .map((spalte) => {
          const beispiele = tabelle.samples?.[spalte.name];
          return (
            `${spalte.name} ${spalte.type}` +
            (beispiele && beispiele.length > 0 ? ` (z. B. ${beispiele.join(", ")})` : "")
          );
        })
        .join("; ");
      return `Tabelle "${tabelle.name}" (${tabelle.rows.toLocaleString("de-DE")} Zeilen): ${spalten}`;
    });
  }

  if (!schema || schema.kind !== "graph" || schema.nodes === 0) {
    return ["Graph ist noch leer."];
  }
  return [
    `Graph: ${schema.nodes.toLocaleString("de-DE")} Knoten, ${schema.relationships.toLocaleString("de-DE")} Kanten`,
    `Labels: ${schema.labels.join(", ") || "—"}`,
    `Beziehungstypen: ${schema.relationshipTypes.join(", ") || "—"}`,
    `Eigenschaften: ${schema.propertyKeys.join(", ") || "—"}`,
  ];
}

function kuerze(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Eine Fundstelle, wie sie unter der Antwort erscheint. */
export type Fundstelle = {
  n: number;
  filename: string;
  location: string | null;
  score: number;
  snippet: string;
  collectionName: string;
};

/**
 * Sammelt die Fundstellen eines Antwortdurchlaufs.
 *
 * Das Werkzeug liefert dem Modell Text, die Oberflaeche braucht daneben
 * strukturierte Herkunftsangaben. Beides aus einem Rueckgabewert zu gewinnen
 * ginge nur, indem man dem Modell eine Struktur mitgibt, die es nicht braucht.
 * Der Sammler haelt sie deshalb daneben fest und vergibt dabei die
 * Nummerierung, mit der das Modell seine Aussagen belegt.
 */
export class Fundstellensammler {
  private readonly treffer: Fundstelle[] = [];
  private readonly gesehen = new Set<string>();

  /**
   * Nimmt Treffer auf und liefert die neu aufgenommenen zurueck — samt
   * Volltext, damit der Aufrufer daraus den Kontext fuer das Modell bauen kann,
   * ohne die Zuordnung zur Nummer erneut suchen zu muessen.
   */
  fuegeHinzu(
    hits: Hit[],
    sammlungsname: string,
  ): { fundstelle: Fundstelle; volltext: string }[] {
    const neu: { fundstelle: Fundstelle; volltext: string }[] = [];

    for (const hit of hits) {
      // Zwei Suchdurchgaenge liefern haeufig ueberlappende Abschnitte. Eine
      // doppelte Fundstelle wuerde die Liste unter der Antwort aufblaehen und
      // dem Modell zwei Nummern fuer denselben Text anbieten.
      const schluessel = `${hit.metadata.docId}#${hit.metadata.chunkIndex}`;
      if (this.gesehen.has(schluessel)) continue;
      this.gesehen.add(schluessel);

      const fundstelle: Fundstelle = {
        n: this.treffer.length + 1,
        filename: hit.metadata.filename,
        location: hit.metadata.location ?? null,
        score: Math.round(hit.score * 1000) / 1000,
        snippet: hit.metadata.text.slice(0, 240),
        collectionName: sammlungsname,
      };

      this.treffer.push(fundstelle);
      neu.push({ fundstelle, volltext: hit.metadata.text });
    }

    return neu;
  }

  get alle(): Fundstelle[] {
    return this.treffer;
  }
}

/**
 * Das Werkzeug, mit dem das Modell selbst entscheidet, wo es sucht.
 *
 * Sicherheitskern: `ladeEigeneSammlungen` filtert die genannten IDs gegen die
 * Sammlungen des Aufrufers. Die IDs stammen aus einem Text, den zu einem Teil
 * hochgeladene Dokumente beeinflussen — sie sind damit grundsaetzlich
 * unvertrauenswuerdig. Halluziniert das Modell eine fremde ID oder wird es per
 * Prompt-Injection dazu verleitet, kommt sie hier nicht durch.
 */
export function baueSuchwerkzeug(userId: string, sammler: Fundstellensammler) {
  return tool({
    description:
      "Durchsucht eine oder mehrere der aufgelisteten Dokumentensammlungen und " +
      "liefert die passendsten Textabschnitte samt Herkunft zurueck.",
    inputSchema: z.object({
      collectionIds: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe(
          "IDs der Sammlungen, die durchsucht werden sollen. Mehrere angeben, " +
            "wenn die Frage Inhalte aus mehreren Bestaenden beruehrt.",
        ),
      suchbegriff: z
        .string()
        .min(2)
        .max(500)
        .describe("Inhaltliche Suchanfrage, keine an dich selbst gerichtete Frage."),
    }),
    execute: async ({ collectionIds, suchbegriff }) => {
      const erlaubt = await ladeEigeneSammlungen(userId, collectionIds);

      if (erlaubt.length === 0) {
        return {
          hinweis:
            "Keine der genannten Sammlungen existiert oder ist zugaenglich. " +
            "Bitte eine der oben aufgelisteten IDs verwenden.",
          abschnitte: [],
        };
      }

      // Parallel: drei Sammlungen sollen eine Wartezeit kosten und nicht drei.
      const ergebnisse = await Promise.all(
        erlaubt.map(async (sammlung) => ({
          sammlung,
          hits: await sucheMitSchwelle(sammlung, suchbegriff),
        })),
      );

      const abschnitte = ergebnisse.flatMap(({ sammlung, hits }) =>
        sammler.fuegeHinzu(hits, sammlung.name).map(({ fundstelle, volltext }) => ({
          nummer: fundstelle.n,
          sammlung: sammlung.name,
          quelle: fundstelle.location
            ? `${fundstelle.filename}, ${fundstelle.location}`
            : fundstelle.filename,
          text: volltext,
        })),
      );

      if (abschnitte.length === 0) {
        return {
          hinweis:
            "Kein Abschnitt der durchsuchten Sammlungen passt hinreichend zur Suchanfrage. " +
            "Ein weiterer Versuch mit anderen Begriffen ist moeglich.",
          abschnitte: [],
        };
      }

      return {
        hinweis: "Belege jede Aussage mit der Nummer des Abschnitts in eckigen Klammern.",
        abschnitte,
      };
    },
  });
}

/**
 * Sucht in einer Sammlung mit ihrem topK und filtert Rauschen unterhalb ihrer
 * Aehnlichkeitsschwelle aus. Beides kommt aus dem Preset, sofern die Sammlung
 * es nicht im Expertenmodus uebersteuert hat.
 */
export async function sucheMitSchwelle(
  sammlung: SammlungMitKlasse,
  suchbegriff: string,
): Promise<Hit[]> {
  const verarbeitung = effektiveVerarbeitung(sammlung);
  const hits = await sucheInSammlung(sammlung.id, suchbegriff, verarbeitung.topK);
  return hits.filter((hit) => hit.score >= verarbeitung.minScore);
}

/**
 * Kontextblock fuer den Weg ohne Werkzeug.
 *
 * Hat ein Nutzer nur eine Sammlung, gibt es nichts auszuwaehlen. Dann wird
 * direkt gesucht und der Kontext der Frage vorangestellt — das spart einen
 * kompletten Modelldurchlauf. Bei 15.000 Nutzern, von denen die meisten mit
 * einer Sammlung arbeiten, ist das der wirksamste einzelne Einspareffekt im
 * ganzen Frageweg.
 */
export function baueKontextblock(
  eintraege: { fundstelle: Fundstelle; volltext: string }[],
): string {
  const auszuege = eintraege.map(({ fundstelle, volltext }) => {
    const quelle = fundstelle.location
      ? `${fundstelle.filename}, ${fundstelle.location}`
      : fundstelle.filename;
    return `[${fundstelle.n}] Quelle: ${quelle}\n${volltext}`;
  });

  return `Auszuege aus der Dokumentensammlung:\n\n${auszuege.join("\n\n---\n\n")}`;
}
