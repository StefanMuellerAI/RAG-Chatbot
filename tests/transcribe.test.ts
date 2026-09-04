import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({
  transcribe: vi.fn(),
  gateway: { transcriptionModel: vi.fn(() => ({ id: "openai/whisper-1" })) },
}));
vi.mock("ai", () => ({
  transcribe: ai.transcribe,
  gateway: ai.gateway,
}));

const env = vi.hoisted(() => ({
  gatewayBereit: vi.fn(async () => true),
  providerKeySecretKonfiguriert: vi.fn(() => false),
}));
vi.mock("@/lib/env", async (original) => {
  const actual = await original<typeof import("@/lib/env")>();
  return {
    ...actual,
    gatewayBereit: env.gatewayBereit,
    providerKeySecretKonfiguriert: env.providerKeySecretKonfiguriert,
  };
});

import {
  bloeckeAusTranskript,
  formatZeit,
  fuegeTranskripteZusammen,
  transkribiereMp3Teil,
} from "@/lib/transcribe";

describe("formatZeit", () => {
  it("formatiert Minuten und Stunden", () => {
    expect(formatZeit(0)).toBe("0:00");
    expect(formatZeit(192)).toBe("3:12");
    expect(formatZeit(3723)).toBe("1:02:03");
  });
});

describe("bloeckeAusTranskript", () => {
  it("buendelt Segmente mit Zeitspanne als Fundstelle", () => {
    const { bloecke, seiten } = bloeckeAusTranskript("wird ignoriert", [
      { text: "Guten Tag.", startSecond: 3, endSecond: 5 },
      { text: "Das Protokoll beginnt.", startSecond: 5, endSecond: 9 },
    ]);
    expect(bloecke).toHaveLength(1);
    expect(bloecke[0].location).toBe("0:03–0:09");
    expect(bloecke[0].text).toContain("Guten Tag.");
    expect(seiten).toBe(1);
  });

  it("legt ohne Segmente einen Block 'Transkription' an", () => {
    const { bloecke } = bloeckeAusTranskript("Nur der Volltext.", []);
    expect(bloecke).toEqual([{ text: "Nur der Volltext.", location: "Transkription" }]);
  });

  it("liefert leer, wenn nichts Verwertbares da ist", () => {
    expect(bloeckeAusTranskript("  ", [])).toEqual({ bloecke: [], seiten: 0 });
  });
});

describe("fuegeTranskripteZusammen", () => {
  it("versetzt Zeiten und schneidet die Ueberlappung des Folge-Teils weg", () => {
    const { bloecke } = fuegeTranskripteZusammen([
      {
        text: "Hallo Welt",
        segments: [
          { text: "Hallo", startSecond: 0, endSecond: 5 },
          { text: "Welt", startSecond: 5, endSecond: 10 },
        ],
        durationInSeconds: 10,
        overlapStartSekunden: 0,
      },
      {
        text: "Welt morgen",
        segments: [
          { text: "Welt", startSecond: 0, endSecond: 3 },
          { text: "morgen", startSecond: 3, endSecond: 8 },
        ],
        durationInSeconds: 8,
        overlapStartSekunden: 3,
      },
    ]);

    expect(bloecke).toHaveLength(1);
    expect(bloecke[0].text).toBe("Hallo Welt morgen");
    expect(bloecke[0].location).toBe("0:00–0:15");
  });
});

describe("transkribiereMp3Teil", () => {
  beforeEach(() => {
    ai.transcribe.mockReset();
    env.gatewayBereit.mockResolvedValue(true);
  });

  it("ruft das Gateway auf und uebernimmt Segmente", async () => {
    ai.transcribe.mockResolvedValue({
      text: "Guten Morgen.",
      segments: [{ text: "Guten Morgen.", startSecond: 0.2, endSecond: 1.8 }],
      durationInSeconds: 2,
    });

    const ergebnis = await transkribiereMp3Teil(new Uint8Array([1, 2, 3]), {
      startByte: 0,
      endByte: 3,
      dauerSekunden: 2.5,
      overlapStartSekunden: 0,
    });

    expect(ai.gateway.transcriptionModel).toHaveBeenCalledWith("openai/whisper-1");
    expect(ergebnis.text).toBe("Guten Morgen.");
    expect(ergebnis.segments).toEqual([
      { text: "Guten Morgen.", startSecond: 0.2, endSecond: 1.8 },
    ]);
    expect(ergebnis.durationInSeconds).toBe(2);
  });
});
