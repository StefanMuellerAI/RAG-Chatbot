import { gateway, tool } from "ai";
import { z } from "zod";
import { ladeEigeneSammlungen, type SammlungMitKlasse } from "./collections";
import { findPreset } from "./presets";
import { MIN_SCORE, sucheInSammlung, type Hit } from "./vector";

/**
 * Modellzugriff, Systemanweisung und das Werkzeug zur Sammlungsauswahl.
 */

/** Alle Modellaufrufe laufen ueber das AI Gateway. */
export function modell(modelId: string) {
  // Auth: AI_GATEWAY_API_KEY, oder auf Vercel der OIDC-Token aus dem
  // Request-Header `x-vercel-oidc-token` (nicht aus process.env).
  return gateway(modelId);
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
 * Katalog der Sammlungen fuer die Systemanweisung.
 *
 * Dieser Text entscheidet ueber die Qualitaet der Auswahl: Das Modell sieht
 * ausschliesslich Name und Beschreibung, nicht den Inhalt. Eine Sammlung ohne
 * Beschreibung ist fuer die Auswahl praktisch unsichtbar — deshalb wird sie
 * nach der ersten Ingestion automatisch vorgeschlagen.
 */
export function baueKatalog(sammlungen: SammlungMitKlasse[]): string {
  const zeilen = sammlungen.map((sammlung) => {
    const preset = findPreset(sammlung.preset);
    const beschreibung = sammlung.description || "(keine Beschreibung hinterlegt)";
    return (
      `- id: ${sammlung.id}\n` +
      `  Name: ${sammlung.name}\n` +
      `  Inhalt: ${beschreibung}\n` +
      `  Art: ${preset.label} · ${sammlung.documentCount} Dokumente`
    );
  });

  return `Verfuegbare Sammlungen:\n\n${zeilen.join("\n")}`;
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

/** Sucht in einer Sammlung mit dem topK ihres Presets und filtert Rauschen aus. */
export async function sucheMitSchwelle(
  sammlung: SammlungMitKlasse,
  suchbegriff: string,
): Promise<Hit[]> {
  const preset = findPreset(sammlung.preset);
  const hits = await sucheInSammlung(sammlung.id, suchbegriff, preset.topK);
  return hits.filter((hit) => hit.score >= MIN_SCORE);
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
