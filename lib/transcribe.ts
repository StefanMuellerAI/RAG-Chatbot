import { createOpenAI } from "@ai-sdk/openai";
import { gateway, transcribe } from "ai";
import { checkIngestionCapacity, ingestionSignal } from "./capacity";
import { ZEICHEN_JE_SEITE, type ExtractedBlock, type Extraktion } from "./extract";
import { gatewayBereit, MissingConfigError, providerKeySecretKonfiguriert } from "./env";
import type { Mp3Teil } from "./mp3-teile";
import { ladeKey } from "./provider-keys";

/**
 * MP3-Transkription fuer den Ingest-Weg.
 *
 * Das Zerlegen in Teilstuecke (lib/mp3-teile.ts) bleibt frei von Netz. Hier
 * liegt der Gateway-Aufruf, das Zusammenfuegen mit Zeitversatz und das
 * Umsetzen in dieselben Bloecke, die PDF/DOCX nach der Extraktion liefern.
 */

/** Gateway-Kennung. Gegen den Live-Katalog geprueft: Segmente mit Zeitstempeln. */
export const TRANSCRIBE_MODEL_ID = "openai/whisper-1";

/** Zielgroesse eines Zitatblocks — wie das Fliesstext-Preset, damit Fundstellen greifbar bleiben. */
const BLOCK_ZEICHEN = 1_200;

export type TranskriptSegment = {
  text: string;
  startSecond: number;
  endSecond: number;
};

/** Serialisierbares Ergebnis eines Teil-Schritts — darf in den Ablaufspeicher. */
export type TranskriptTeilErgebnis = {
  text: string;
  segments: TranskriptSegment[];
  durationInSeconds: number;
  overlapStartSekunden: number;
};

/**
 * Koennen wir eine MP3 transkribieren? Gateway (Schluessel oder OIDC) oder ein
 * hinterlegter OpenAI-Key. Wird schon bei der Upload-Anmeldung geprueft, damit
 * die Datei nicht erst im Workflow scheitert.
 */
export async function transkriptionBereit(): Promise<boolean> {
  if (await gatewayBereit()) return true;
  if (!providerKeySecretKonfiguriert()) return false;
  try {
    return (await ladeKey("openai")) !== null;
  } catch {
    return false;
  }
}

export async function transkribiereMp3Teil(
  bytes: Uint8Array,
  teil: Mp3Teil,
): Promise<TranskriptTeilErgebnis> {
  checkIngestionCapacity();
  const modell = await transkriptionsModell();
  checkIngestionCapacity();
  const ergebnis = await transcribe({
    model: modell,
    audio: bytes,
    maxRetries: 0,
    abortSignal: ingestionSignal(),
  });

  return {
    text: ergebnis.text ?? "",
    segments: (ergebnis.segments ?? []).map((segment) => ({
      text: segment.text,
      startSecond: segment.startSecond,
      endSecond: segment.endSecond,
    })),
    durationInSeconds: ergebnis.durationInSeconds ?? teil.dauerSekunden,
    overlapStartSekunden: teil.overlapStartSekunden,
  };
}

async function transkriptionsModell() {
  if (await gatewayBereit()) {
    return gateway.transcriptionModel(TRANSCRIBE_MODEL_ID);
  }

  if (providerKeySecretKonfiguriert()) {
    const key = await ladeKey("openai");
    if (key) return createOpenAI({ apiKey: key }).transcription("whisper-1");
  }

  throw new MissingConfigError(["AI_GATEWAY_API_KEY"]);
}

/**
 * Versetzt Teil-Transkripte auf eine gemeinsame Zeitachse, schneidet die
 * Ueberlappung am Beginn von Teil n>0 weg und baut die Extraktionsbloecke.
 */
export function fuegeTranskripteZusammen(teile: TranskriptTeilErgebnis[]): Extraktion {
  const segments: TranskriptSegment[] = [];
  const texte: string[] = [];
  let offset = 0;

  for (const teil of teile) {
    const unique = teil.segments.filter(
      (segment) => segment.startSecond >= teil.overlapStartSekunden,
    );

    if (unique.length > 0) {
      for (const segment of unique) {
        segments.push({
          text: segment.text,
          startSecond: segment.startSecond + offset - teil.overlapStartSekunden,
          endSecond: segment.endSecond + offset - teil.overlapStartSekunden,
        });
      }
      const stueck = unique
        .map((segment) => segment.text.trim())
        .filter((text) => text.length > 0)
        .join(" ");
      if (stueck) texte.push(stueck);
    } else if (teil.text.trim()) {
      texte.push(teil.text.trim());
    }

    offset += Math.max(teil.durationInSeconds - teil.overlapStartSekunden, 0);
  }

  return bloeckeAusTranskript(texte.join("\n"), segments);
}

export function bloeckeAusTranskript(text: string, segments: TranskriptSegment[]): Extraktion {
  const nutzbar = segments.filter((segment) => segment.text.trim().length > 0);

  if (nutzbar.length > 0) {
    const bloecke = gruppiereSegmente(nutzbar);
    const volltext = nutzbar.map((segment) => segment.text.trim()).join(" ");
    return { bloecke, seiten: seitenAusZeichen(volltext.length) };
  }

  const sauber = text.trim();
  if (!sauber) return { bloecke: [], seiten: 0 };

  return {
    bloecke: [{ text: sauber, location: "Transkription" }],
    seiten: seitenAusZeichen(sauber.length),
  };
}

export function formatZeit(sekunden: number): string {
  const s = Math.max(0, Math.floor(sekunden));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const ss = String(rest).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function gruppiereSegmente(segments: TranskriptSegment[]): ExtractedBlock[] {
  const bloecke: ExtractedBlock[] = [];
  let aktuell: TranskriptSegment[] = [];
  let laenge = 0;

  const abschliessen = () => {
    if (aktuell.length === 0) return;
    const text = aktuell
      .map((segment) => segment.text.trim())
      .filter((teil) => teil.length > 0)
      .join(" ");
    if (!text) {
      aktuell = [];
      laenge = 0;
      return;
    }
    const start = aktuell[0].startSecond;
    const ende = aktuell[aktuell.length - 1].endSecond;
    bloecke.push({
      text,
      location: `${formatZeit(start)}–${formatZeit(ende)}`,
    });
    aktuell = [];
    laenge = 0;
  };

  for (const segment of segments) {
    const extra = segment.text.trim().length;
    if (aktuell.length > 0 && laenge + extra > BLOCK_ZEICHEN) {
      abschliessen();
    }
    aktuell.push(segment);
    laenge += extra;
  }
  abschliessen();
  return bloecke;
}

function seitenAusZeichen(zeichen: number): number {
  return Math.max(Math.ceil(zeichen / ZEICHEN_JE_SEITE), zeichen > 0 ? 1 : 0);
}
