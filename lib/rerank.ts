import { Pinecone } from "@pinecone-database/pinecone";
import { optionalEnv, requireEnv } from "./env";
import type { Hit } from "./vector";

/**
 * Reranker nach der Vektorsuche.
 *
 * Die Vektorsuche findet, was ungefaehr zur Frage passt; ein Cross-Encoder
 * liest Frage und Abschnitt zusammen und sagt, wie gut sie wirklich
 * zueinander passen. Die Kosinus-Schwelle bleibt nur ein grober Vorfilter,
 * Reihenfolge und Zuschnitt der Belege entscheidet der Reranker.
 *
 * Eingeschaltet wird er ueber RERANK_MODEL. Ohne die Variable bleibt alles,
 * wie es war: Ein Rerank-Ausfall darf nie eine Antwort verhindern, deshalb
 * faellt die Funktion bei Zeitueberschreitung oder Fehler still auf die
 * Kosinus-Reihenfolge zurueck und meldet das in der Messung.
 */

/** Mehrsprachig, deshalb fuer deutsche Unterlagen die erste Wahl. */
export const RERANK_STANDARD_MODELL = "bge-reranker-v2-m3";
/** Mehr Kandidaten kosten Zeit, ohne die Reihenfolge der besten zu verbessern. */
export const RERANK_MAX_KANDIDATEN = 50;
/** Je Abschnitt so viele Zeichen; laengere Abschnitte werden fuer das Modell gekuerzt. */
const RERANK_MAX_ZEICHEN = 2_000;
const RERANK_ZEITLIMIT_MS = 2_500;

export function rerankModell(): string | undefined {
  const wert = optionalEnv("RERANK_MODEL")?.trim();
  if (!wert) return undefined;
  return ["1", "true", "an", "on", "ja"].includes(wert.toLowerCase()) ? RERANK_STANDARD_MODELL : wert;
}

export function rerankKonfiguriert(): boolean {
  return rerankModell() !== undefined;
}

export type Kandidat = { hit: Hit; sammlungsname: string; minRerank: number };

export type RerankMessung = {
  angewendet: boolean;
  dauerMs: number;
  kandidaten: number;
  uebernommen: number;
  fehler?: string;
};

export type RerankErgebnis = { treffer: Kandidat[]; messung: RerankMessung };

/**
 * Ordnet Kandidaten aus einer oder mehreren Sammlungen nach Relevanz zur
 * Frage und schneidet auf `hoechstens` zu. Jeder Kandidat bringt die Schwelle
 * seiner Sammlung mit; darunter gilt er als Rauschen.
 *
 * Im Ergebnis traegt `hit.score` den Rerank-Wert (0 bis 1). Ohne Modell oder
 * bei einem Fehler bleibt die Kosinus-Reihenfolge, auf `hoechstens` gekuerzt.
 */
export async function ordneNeu(
  frage: string,
  kandidaten: Kandidat[],
  options: { hoechstens: number; signal?: AbortSignal; zeitlimitMs?: number },
): Promise<RerankErgebnis> {
  const start = Date.now();
  const nachKosinus = () =>
    [...kandidaten].sort((a, b) => b.hit.score - a.hit.score).slice(0, options.hoechstens);
  const modell = rerankModell();

  if (!modell || kandidaten.length === 0) {
    return {
      treffer: nachKosinus(),
      messung: { angewendet: false, dauerMs: 0, kandidaten: kandidaten.length, uebernommen: Math.min(kandidaten.length, options.hoechstens) },
    };
  }

  // Die besten Kandidaten nach Kosinus; mehr als RERANK_MAX_KANDIDATEN
  // verbessern die Spitze nicht, kosten aber Zeit beim Anbieter.
  const auswahl = [...kandidaten]
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, RERANK_MAX_KANDIDATEN);

  try {
    const env = requireEnv("PINECONE_API_KEY");
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.zeitlimitMs ?? RERANK_ZEITLIMIT_MS),
    ]);
    const pinecone = new Pinecone({
      apiKey: env.PINECONE_API_KEY,
      maxRetries: 0,
      fetchApi: (url, init) => fetch(url, { ...init, signal }),
    });
    const antwort = await pinecone.inference.rerank({
      model: modell,
      query: frage,
      documents: auswahl.map((kandidat) => kandidat.hit.metadata.text.slice(0, RERANK_MAX_ZEICHEN)),
      topN: Math.min(options.hoechstens, auswahl.length),
      returnDocuments: false,
      parameters: { truncate: "END" },
    });

    const treffer: Kandidat[] = [];
    for (const zeile of antwort.data) {
      const kandidat = auswahl[zeile.index];
      if (!kandidat || zeile.score < kandidat.minRerank) continue;
      treffer.push({ ...kandidat, hit: { ...kandidat.hit, score: zeile.score } });
    }
    return {
      treffer,
      messung: { angewendet: true, dauerMs: Date.now() - start, kandidaten: auswahl.length, uebernommen: treffer.length },
    };
  } catch (error) {
    // Ein Abbruch durch den Nutzer ist kein Rerank-Fehler und geht nach oben.
    if (options.signal?.aborted) throw error;
    const treffer = nachKosinus();
    return {
      treffer,
      messung: {
        angewendet: false, dauerMs: Date.now() - start, kandidaten: auswahl.length, uebernommen: treffer.length,
        fehler: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
