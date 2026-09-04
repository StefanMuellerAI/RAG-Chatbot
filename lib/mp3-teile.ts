import { ValidationError } from "./errors";

/**
 * Zerlegt eine MP3 in Teilstuecke unter der Transkriptions-API-Grenze.
 *
 * Die API nimmt hoechstens 25 MB je Aufruf. Upload und Kontingent folgen der
 * Groessenklasse und koennen darueber liegen — deshalb dieser Rahmenlaeufer:
 * MPEG-Rahmen zaehlen, Split-Punkte merken, Audiodaten nicht im Speicher
 * behalten. Kein ffmpeg: die Rahmenlaenge steht im Header (CBR und VBR).
 *
 * Eine kurze Ueberlappung am Schnitt soll verhindern, dass ein mitten im Wort
 * getrennter Satz in keinem der beiden Teile vollstaendig vorkommt.
 */

/** Puffer unter der 25-MB-API-Grenze, damit der Request nicht knapp danebenliegt. */
export const STT_MAX_BYTES = 24 * 1024 * 1024;

/** Ueberlappung in Sekunden zwischen aufeinanderfolgenden Teilen. */
export const STT_OVERLAP_SEKUNDEN = 3;

export type Mp3Teil = {
  /** Inklusiver Byte-Offset in der Originaldatei. */
  startByte: number;
  /** Exklusiver Byte-Offset. */
  endByte: number;
  /** Geschaetzte Dauer dieses Teils inklusive Ueberlappung am Anfang. */
  dauerSekunden: number;
  /** Sekunden am Beginn, die mit dem vorigen Teil ueberlappen (0 beim ersten). */
  overlapStartSekunden: number;
};

export type Mp3TeilOptionen = {
  maxBytes?: number;
  overlapSekunden?: number;
};

type Rahmen = { start: number; laenge: number; dauer: number };

const BITRATE_MPEG1: Record<1 | 2 | 3, number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const BITRATE_MPEG2: Record<1 | 2 | 3, number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<1 | 2 | 25, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

/**
 * Plant die Teilstuecke. Nimmt einen Puffer (Tests) oder einen Stream (Ingest),
 * damit eine 200-MB-Datei nicht als Ganzes im Schritt liegen muss.
 */
export async function planeMp3Teile(
  quelle: Uint8Array | ReadableStream<Uint8Array>,
  optionen: Mp3TeilOptionen = {},
): Promise<Mp3Teil[]> {
  const maxBytes = optionen.maxBytes ?? STT_MAX_BYTES;
  const overlapSekunden = optionen.overlapSekunden ?? STT_OVERLAP_SEKUNDEN;
  if (maxBytes < 4) {
    throw new ValidationError("Die Teilgroesse fuer die Transkription ist unplausibel klein.");
  }

  const quelleIntern = new ByteQuelle(alsChunks(quelle));
  await ueberspringeId3v2(quelleIntern);

  const teile: Mp3Teil[] = [];
  let aktuell: Rahmen[] = [];
  let bytesAktuell = 0;
  let dauerAktuell = 0;
  let overlapDiesesTeils = 0;

  const schliesseTeil = (naechster: Rahmen | null): void => {
    if (aktuell.length === 0) return;
    const erst = aktuell[0];
    const letzt = aktuell[aktuell.length - 1];
    teile.push({
      startByte: erst.start,
      endByte: letzt.start + letzt.laenge,
      dauerSekunden: dauerAktuell,
      overlapStartSekunden: overlapDiesesTeils,
    });

    if (!naechster) {
      aktuell = [];
      bytesAktuell = 0;
      dauerAktuell = 0;
      overlapDiesesTeils = 0;
      return;
    }

    const overlap = waehleOverlap(aktuell, overlapSekunden, maxBytes);
    aktuell = [...overlap, naechster];
    bytesAktuell = aktuell.reduce((summe, rahmen) => summe + rahmen.laenge, 0);
    dauerAktuell = aktuell.reduce((summe, rahmen) => summe + rahmen.dauer, 0);
    overlapDiesesTeils = overlap.reduce((summe, rahmen) => summe + rahmen.dauer, 0);
  };

  for (;;) {
    const rahmen = await naechsterRahmen(quelleIntern);
    if (!rahmen) break;

    if (rahmen.laenge > maxBytes) {
      throw new ValidationError(
        "Ein MPEG-Rahmen ist groesser als die Transkriptionsgrenze. Die Datei ist vermutlich beschaedigt.",
      );
    }

    if (aktuell.length > 0 && bytesAktuell + rahmen.laenge > maxBytes) {
      schliesseTeil(rahmen);
      continue;
    }

    aktuell.push(rahmen);
    bytesAktuell += rahmen.laenge;
    dauerAktuell += rahmen.dauer;
  }

  schliesseTeil(null);

  if (teile.length === 0) {
    throw new ValidationError(
      "Aus der MP3 liessen sich keine MPEG-Rahmen lesen. Die Datei ist leer oder kein gueltiges MPEG-Audio.",
    );
  }

  return teile;
}

/** Waehlt Rahmen vom Ende, die mindestens `sekunden` abdecken, ohne den ganzen Teil. */
export function waehleOverlap(rahmen: Rahmen[], sekunden: number, maxBytes: number): Rahmen[] {
  if (sekunden <= 0 || rahmen.length <= 1) return [];

  // Hoechstens die zweite Haelfte — sonst wuerde der naechste Teil nicht vorwaerts gehen.
  const maxRahmen = Math.max(1, Math.floor(rahmen.length / 2));
  const taken: Rahmen[] = [];
  let dauer = 0;
  let bytes = 0;

  for (let i = rahmen.length - 1; i >= 1 && taken.length < maxRahmen; i--) {
    const kandidat = rahmen[i];
    if (bytes + kandidat.laenge >= maxBytes) break;
    taken.unshift(kandidat);
    dauer += kandidat.dauer;
    bytes += kandidat.laenge;
    if (dauer >= sekunden) break;
  }

  return taken;
}

// --- MPEG-Header ------------------------------------------------------------

function leseRahmenkopf(data: Uint8Array, offset: number): { laenge: number; dauer: number } | null {
  if (offset + 4 > data.length) return null;
  if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return null;

  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;

  if (versionBits === 1 || layerBits === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;

  const version: 1 | 2 | 25 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const tabelle = version === 1 ? BITRATE_MPEG1 : BITRATE_MPEG2;
  const bitrate = tabelle[layer][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleIndex];
  if (!bitrate || !sampleRate) return null;

  let laenge: number;
  if (layer === 1) {
    laenge = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  } else if (layer === 3 && version !== 1) {
    laenge = Math.floor((72 * bitrate) / sampleRate) + padding;
  } else {
    laenge = Math.floor((144 * bitrate) / sampleRate) + padding;
  }

  if (laenge < 4) return null;

  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  return { laenge, dauer: samples / sampleRate };
}

// --- Stream-Leser -----------------------------------------------------------

async function* alsChunks(
  quelle: Uint8Array | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (quelle instanceof Uint8Array) {
    if (quelle.byteLength > 0) yield quelle;
    return;
  }

  const reader = quelle.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

class ByteQuelle {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private abs = 0;
  private ended = false;
  private iterator: AsyncIterator<Uint8Array>;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  get offset(): number {
    return this.abs;
  }

  get length(): number {
    return this.buf.length;
  }

  get eof(): boolean {
    return this.ended && this.buf.length === 0;
  }

  async ensure(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.ended) {
      const next = await this.pull();
      if (!next) {
        this.ended = true;
        break;
      }
      this.buf = verbinden(this.buf, next);
    }
    return this.buf.length >= n;
  }

  bytes(start: number, end: number): Uint8Array {
    return this.buf.subarray(start, end);
  }

  consume(n: number): void {
    if (n <= 0) return;
    const nimmt = Math.min(n, this.buf.length);
    this.abs += nimmt;
    this.buf = this.buf.subarray(nimmt);
  }

  async skip(n: number): Promise<void> {
    let rest = n;
    while (rest > 0) {
      if (this.buf.length === 0) {
        const next = await this.pull();
        if (!next) {
          this.ended = true;
          return;
        }
        this.buf = next;
      }
      const nimmt = Math.min(rest, this.buf.length);
      this.consume(nimmt);
      rest -= nimmt;
    }
  }

  private async pull(): Promise<Uint8Array | null> {
    const { done, value } = await this.iterator.next();
    if (done) return null;
    return value ?? null;
  }
}

function verbinden(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function ueberspringeId3v2(quelle: ByteQuelle): Promise<void> {
  if (!(await quelle.ensure(10))) return;
  const kopf = quelle.bytes(0, 10);
  if (kopf[0] !== 0x49 || kopf[1] !== 0x44 || kopf[2] !== 0x33) return;

  const groesse =
    ((kopf[6] & 0x7f) << 21) | ((kopf[7] & 0x7f) << 14) | ((kopf[8] & 0x7f) << 7) | (kopf[9] & 0x7f);
  const fuss = (kopf[5] & 0x10) !== 0 ? 10 : 0;
  await quelle.skip(10 + groesse + fuss);
}

async function naechsterRahmen(quelle: ByteQuelle): Promise<Rahmen | null> {
  for (;;) {
    if (!(await quelle.ensure(4))) return null;

    // ID3v1 am Dateiende: 128 Bytes, beginnend mit "TAG".
    if (quelle.length === 128 || (quelle.eof && quelle.length <= 128)) {
      const tag = quelle.bytes(0, 3);
      if (tag[0] === 0x54 && tag[1] === 0x41 && tag[2] === 0x47) return null;
    }

    if (quelle.bytes(0, 1)[0] !== 0xff || (quelle.bytes(1, 2)[0] & 0xe0) !== 0xe0) {
      quelle.consume(1);
      continue;
    }

    const kopf = leseRahmenkopf(quelle.bytes(0, Math.min(quelle.length, 4)), 0);
    if (!kopf) {
      quelle.consume(1);
      continue;
    }

    const hatNaechsten = await quelle.ensure(kopf.laenge + 4);
    const hatGanzen = await quelle.ensure(kopf.laenge);
    if (!hatGanzen) return null;

    if (hatNaechsten) {
      const weiter = leseRahmenkopf(quelle.bytes(kopf.laenge, kopf.laenge + 4), 0);
      if (!weiter) {
        const rest = quelle.length - kopf.laenge;
        const tag =
          rest >= 3 ? quelle.bytes(kopf.laenge, kopf.laenge + 3) : new Uint8Array();
        const siehtNachTagAus =
          rest === 0 ||
          rest === 128 ||
          (tag.length === 3 && tag[0] === 0x54 && tag[1] === 0x41 && tag[2] === 0x47);
        if (!siehtNachTagAus && rest > 4) {
          quelle.consume(1);
          continue;
        }
      }
    }

    const rahmen: Rahmen = { start: quelle.offset, laenge: kopf.laenge, dauer: kopf.dauer };
    await quelle.skip(kopf.laenge);
    return rahmen;
  }
}
