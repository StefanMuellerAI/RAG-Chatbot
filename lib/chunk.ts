import type { ExtractedBlock } from "./extract";
import type { UpsertChunk } from "./vector";

/**
 * Zerlegt die extrahierten Bloecke in ueberlappende Abschnitte.
 *
 * Geschnitten wird bevorzugt an Absatz-, ersatzweise an Satzgrenzen: ein
 * Abschnitt, der mitten im Satz endet, liefert beim Embedding ein unscharfes
 * Signal und liest sich im Zitat schlecht. Die Ueberlappung sorgt dafuer, dass
 * eine Aussage, die genau auf einer Schnittkante liegt, nicht verloren geht.
 */

const TARGET_SIZE = 1000;
const OVERLAP = 150;

/**
 * Untergrenze fuer einen Abschnitt. Sie soll nur echte Artefakte abfangen —
 * eine allein stehende Seitenzahl etwa. Sie darf NICHT dazu fuehren, dass ein
 * kurzer, aber inhaltlich vollstaendiger Block verworfen wird: ein knappes
 * Tabellenblatt mit den Oeffnungszeiten ist genau die Art Information, nach
 * der spaeter gefragt wird.
 *
 * Beim Aufteilen kann ohnehin kein zu kurzes Reststueck entstehen: der naechste
 * Abschnitt beginnt stets OVERLAP Zeichen vor dem Ende des vorherigen, ein Rest
 * ist damit immer mindestens OVERLAP lang.
 */
const MIN_SIZE = 15;

export function chunkBlocks(blocks: ExtractedBlock[]): UpsertChunk[] {
  const chunks: UpsertChunk[] = [];

  for (const block of blocks) {
    for (const text of splitText(block.text)) {
      chunks.push(block.location ? { text, location: block.location } : { text });
    }
  }

  return chunks;
}

function splitText(text: string): string[] {
  if (text.length <= TARGET_SIZE) {
    return istVerwertbar(text) ? [text] : [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + TARGET_SIZE, text.length);
    const end = hardEnd === text.length ? hardEnd : findBreak(text, start, hardEnd);
    const chunk = text.slice(start, end).trim();

    if (istVerwertbar(chunk)) chunks.push(chunk);
    if (end >= text.length) break;

    // Ueberlappung, aber immer echten Fortschritt erzwingen — sonst dreht
    // sich die Schleife bei sehr kurzen Segmenten endlos.
    start = Math.max(end - OVERLAP, start + 1);
  }

  return chunks;
}

/** Sucht rueckwaerts ab `hardEnd` die beste Schnittkante. */
function findBreak(text: string, start: number, hardEnd: number): number {
  const earliest = start + Math.floor(TARGET_SIZE / 2);

  const paragraph = text.lastIndexOf("\n\n", hardEnd);
  if (paragraph > earliest) return paragraph;

  for (const marker of [". ", ".\n", "! ", "? ", "; "]) {
    const position = text.lastIndexOf(marker, hardEnd);
    if (position > earliest) return position + marker.length;
  }

  const space = text.lastIndexOf(" ", hardEnd);
  return space > earliest ? space : hardEnd;
}

/** Enthaelt der Abschnitt genug Substanz, um durchsuchbar zu sein? */
function istVerwertbar(text: string): boolean {
  return text.length >= MIN_SIZE && /[\p{L}\p{N}]/u.test(text);
}
