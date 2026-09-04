import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { planeMp3Teile } from "@/lib/mp3-teile";

/**
 * MPEG-1 Layer III, 128 kbit/s, 44,1 kHz, kein Padding: 417 Bytes je Rahmen,
 * 1152 Samples → 1152/44100 s Dauer.
 */
const RAHMEN_LAENGE = Math.floor((144 * 128_000) / 44_100);
const RAHMEN_DAUER = 1152 / 44_100;

function rahmen128k(anzahl: number, id3Bytes = 0): Uint8Array {
  const audio = new Uint8Array(anzahl * RAHMEN_LAENGE);
  const kopf = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  for (let i = 0; i < anzahl; i++) {
    audio.set(kopf, i * RAHMEN_LAENGE);
  }
  if (id3Bytes <= 0) return audio;

  const tag = new Uint8Array(10 + id3Bytes);
  tag[0] = 0x49;
  tag[1] = 0x44;
  tag[2] = 0x33;
  tag[6] = (id3Bytes >> 21) & 0x7f;
  tag[7] = (id3Bytes >> 14) & 0x7f;
  tag[8] = (id3Bytes >> 7) & 0x7f;
  tag[9] = id3Bytes & 0x7f;
  const out = new Uint8Array(tag.length + audio.length);
  out.set(tag);
  out.set(audio, tag.length);
  return out;
}

describe("planeMp3Teile", () => {
  it("liefert bei kleiner Datei genau ein Teil ohne Ueberlappung", async () => {
    const teile = await planeMp3Teile(rahmen128k(8), {
      maxBytes: 24 * 1024 * 1024,
      overlapSekunden: 3,
    });
    expect(teile).toHaveLength(1);
    expect(teile[0]).toMatchObject({
      startByte: 0,
      endByte: 8 * RAHMEN_LAENGE,
      overlapStartSekunden: 0,
    });
    expect(teile[0].dauerSekunden).toBeCloseTo(8 * RAHMEN_DAUER, 6);
  });

  it("schneidet an Rahmengrenzen, wenn die API-Grenze greift", async () => {
    const teile = await planeMp3Teile(rahmen128k(12), {
      maxBytes: 5 * RAHMEN_LAENGE,
      overlapSekunden: 0,
    });
    expect(teile).toHaveLength(3);
    expect(teile.map((teil) => [teil.startByte, teil.endByte])).toEqual([
      [0, 5 * RAHMEN_LAENGE],
      [5 * RAHMEN_LAENGE, 10 * RAHMEN_LAENGE],
      [10 * RAHMEN_LAENGE, 12 * RAHMEN_LAENGE],
    ]);
    for (const teil of teile) {
      expect((teil.endByte - teil.startByte) % RAHMEN_LAENGE).toBe(0);
      expect(teil.overlapStartSekunden).toBe(0);
    }
  });

  it("legt eine kurze Ueberlappung auf den Beginn des naechsten Teils", async () => {
    const teile = await planeMp3Teile(rahmen128k(12), {
      maxBytes: 5 * RAHMEN_LAENGE,
      overlapSekunden: RAHMEN_DAUER * 2,
    });
    expect(teile.length).toBeGreaterThan(1);
    expect(teile[0].overlapStartSekunden).toBe(0);
    expect(teile[1].startByte).toBeLessThan(teile[0].endByte);
    expect(teile[1].startByte).toBeGreaterThan(teile[0].startByte);
    expect(teile[1].overlapStartSekunden).toBeCloseTo(2 * RAHMEN_DAUER, 6);
    expect(teile[1].endByte).toBeGreaterThan(teile[0].endByte);
  });

  it("ueberspringt einen ID3v2-Kopf, bevor die Rahmen zaehlen", async () => {
    const teile = await planeMp3Teile(rahmen128k(4, 20), {
      maxBytes: 24 * 1024 * 1024,
      overlapSekunden: 0,
    });
    expect(teile).toHaveLength(1);
    expect(teile[0].startByte).toBe(30);
    expect(teile[0].endByte).toBe(30 + 4 * RAHMEN_LAENGE);
  });

  it("plant aus einem Stream dieselben Offsets wie aus dem Puffer", async () => {
    const bytes = rahmen128k(9);
    const strom = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const optionen = { maxBytes: 4 * RAHMEN_LAENGE, overlapSekunden: 0 };
    const ausPuffer = await planeMp3Teile(bytes, optionen);
    const ausStrom = await planeMp3Teile(strom, optionen);
    expect(ausStrom).toEqual(ausPuffer);
  });

  it("lehnt Dateien ohne MPEG-Rahmen ab", async () => {
    await expect(planeMp3Teile(new Uint8Array([0, 1, 2, 3, 4]))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
