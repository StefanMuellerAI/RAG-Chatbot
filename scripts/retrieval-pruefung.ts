import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { collections } from "../lib/db/schema";
import { effektiveVerarbeitung } from "../lib/presets";
import { RERANK_AUFWEITUNG, RERANK_MAX_KANDIDATEN_JE_SAMMLUNG, RERANK_SCHWELLEN_NACHLASS } from "../lib/ai";
import { ordneNeu, rerankKonfiguriert, rerankModell, type Kandidat } from "../lib/rerank";
import { sucheInSammlung, type Hit } from "../lib/vector";

/**
 * Retrieval-Pruefung: Kosinus-Reihenfolge gegen Reranker auf echten Daten.
 *
 *   npm run pruefe:retrieval -- fragen.json
 *
 * Die Datei nennt eine Sammlung und Fragen mit den Dateien (oder Dokument-
 * IDs), aus denen die Antwort kommen muss:
 *
 *   {
 *     "collectionId": "3f2a…",
 *     "fragen": [
 *       { "frage": "Was kostet ein Anwohnerparkausweis?", "erwartet": ["gebuehren.pdf"] },
 *       { "frage": "Wann ist das Buergerbuero samstags offen?", "erwartet": ["oeffnungszeiten.pdf", "faq.docx"] }
 *     ]
 *   }
 *
 * Je Frage laeuft eine Vektorsuche mit der breiteren Kandidatenmenge, wie sie
 * der Reranker bekommt. Daraus entstehen beide Reihenfolgen: die Kosinus-
 * Reihenfolge mit topK und Schwelle der Sammlung, und die Reranker-Reihenfolge
 * mit RERANK_MODEL. Gemessen werden Recall@k (Anteil der erwarteten Dateien
 * unter den k Belegen), MRR (wie weit oben der erste Treffer steht) und die
 * Dauer des Rerank-Aufrufs. Ohne RERANK_MODEL zeigt das Skript nur die
 * Kosinus-Werte — als Ausgangspunkt, bevor der Schalter umgelegt wird.
 *
 * Braucht DATABASE_URL, PINECONE_API_KEY und PINECONE_INDEX aus .env.local.
 */

type Fragebogen = {
  collectionId: string;
  fragen: { frage: string; erwartet: string[] }[];
};

type Kennzahlen = { recall: number; mrr: number; belege: number };

async function main() {
  const pfad = process.argv[2];
  if (!pfad) {
    console.error("Aufruf: npm run pruefe:retrieval -- fragen.json");
    process.exit(2);
  }
  const bogen = JSON.parse(await readFile(pfad, "utf8")) as Fragebogen;
  if (!bogen.collectionId || !Array.isArray(bogen.fragen) || bogen.fragen.length === 0) {
    throw new Error("Die Datei braucht collectionId und mindestens eine Frage mit erwartet[].");
  }

  const [sammlung] = await getDb().select().from(collections).where(eq(collections.id, bogen.collectionId)).limit(1);
  if (!sammlung) throw new Error(`Sammlung ${bogen.collectionId} nicht gefunden.`);
  if (sammlung.kind !== "vector") throw new Error("Nur Dokumentensammlungen lassen sich so pruefen.");
  const verarbeitung = effektiveVerarbeitung(sammlung);
  const modell = rerankModell();

  console.log(`Sammlung „${sammlung.name}“ · Preset ${verarbeitung.label} · topK ${verarbeitung.topK} · Schwelle ${verarbeitung.minScore}`);
  console.log(modell
    ? `Reranker: ${modell}${verarbeitung.rerank ? "" : " (fuer diese Sammlung abgeschaltet — wird hier trotzdem gemessen)"} · Relevanz ab ${verarbeitung.minRerank}`
    : "Reranker: nicht konfiguriert (RERANK_MODEL leer) — nur Kosinus-Werte");
  console.log("");

  const kosinusWerte: Kennzahlen[] = [];
  const rerankWerte: Kennzahlen[] = [];
  const dauern: number[] = [];
  let ausfaelle = 0;

  const breite = Math.min(verarbeitung.topK * RERANK_AUFWEITUNG, RERANK_MAX_KANDIDATEN_JE_SAMMLUNG);
  for (const { frage, erwartet } of bogen.fragen) {
    const kandidaten = await sucheInSammlung(sammlung.id, frage, breite);

    const kosinus = kandidaten.filter((hit) => hit.score >= verarbeitung.minScore).slice(0, verarbeitung.topK);
    const k = bewerte(kosinus, erwartet);
    kosinusWerte.push(k);
    let zeile = `${kuerze(frage, 60).padEnd(62)} Kosinus R@${verarbeitung.topK} ${prozent(k.recall)} MRR ${k.mrr.toFixed(2)}`;

    if (rerankKonfiguriert()) {
      const vorauswahl: Kandidat[] = kandidaten
        .filter((hit) => hit.score >= Math.max(0, verarbeitung.minScore - RERANK_SCHWELLEN_NACHLASS))
        .map((hit) => ({ hit, sammlungsname: sammlung.name, minRerank: verarbeitung.minRerank }));
      const ergebnis = await ordneNeu(frage, vorauswahl, { hoechstens: verarbeitung.topK });
      const r = bewerte(ergebnis.treffer.map((kandidat) => kandidat.hit), erwartet);
      rerankWerte.push(r);
      if (ergebnis.messung.angewendet) dauern.push(ergebnis.messung.dauerMs);
      else ausfaelle += 1;
      zeile += ` | Rerank R@${verarbeitung.topK} ${prozent(r.recall)} MRR ${r.mrr.toFixed(2)} ${ergebnis.messung.angewendet ? `${ergebnis.messung.dauerMs} ms` : `AUSFALL (${ergebnis.messung.fehler ?? "?"})`}`;
    }
    console.log(zeile);
  }

  console.log("");
  console.log(`Kosinus  Recall@${verarbeitung.topK} ${prozent(mittel(kosinusWerte.map((w) => w.recall)))} · MRR ${mittel(kosinusWerte.map((w) => w.mrr)).toFixed(2)} · ${mittel(kosinusWerte.map((w) => w.belege)).toFixed(1)} Belege je Frage`);
  if (rerankWerte.length) {
    console.log(`Reranker Recall@${verarbeitung.topK} ${prozent(mittel(rerankWerte.map((w) => w.recall)))} · MRR ${mittel(rerankWerte.map((w) => w.mrr)).toFixed(2)} · ${mittel(rerankWerte.map((w) => w.belege)).toFixed(1)} Belege je Frage · ${dauern.length ? `${Math.round(mittel(dauern))} ms je Aufruf` : "kein Aufruf gelungen"}${ausfaelle ? ` · ${ausfaelle} Ausfaelle` : ""}`);
  }
}

/**
 * Ein erwarteter Eintrag gilt als gefunden, wenn Dateiname oder Dokument-ID
 * eines Belegs ihn enthaelt. Recall zaehlt die gefundenen Eintraege, MRR den
 * Kehrwert der Position des ersten passenden Belegs.
 */
function bewerte(belege: Hit[], erwartet: string[]): Kennzahlen {
  const passt = (hit: Hit, eintrag: string) =>
    hit.metadata.filename.toLowerCase().includes(eintrag.toLowerCase()) || hit.metadata.docId === eintrag;
  const gefunden = erwartet.filter((eintrag) => belege.some((hit) => passt(hit, eintrag)));
  const erster = belege.findIndex((hit) => erwartet.some((eintrag) => passt(hit, eintrag)));
  return {
    recall: erwartet.length ? gefunden.length / erwartet.length : 1,
    mrr: erster < 0 ? 0 : 1 / (erster + 1),
    belege: belege.length,
  };
}

function mittel(werte: number[]): number {
  return werte.length ? werte.reduce((summe, wert) => summe + wert, 0) / werte.length : 0;
}

function prozent(anteil: number): string {
  return `${Math.round(anteil * 100)}%`.padStart(4);
}

function kuerze(text: string, laenge: number): string {
  return text.length > laenge ? `${text.slice(0, laenge - 1)}…` : text;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
