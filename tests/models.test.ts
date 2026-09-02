import { describe, expect, it } from "vitest";
import {
  normalisiereKennung,
  ordnePreisZu,
  preisAusGateway,
  preisJeMillion,
  type GatewayEintrag,
} from "@/lib/anbieter-modelle";
import {
  DEFAULT_MODEL_ID,
  KENNUNG_MUSTER,
  STANDARD_MODELLE,
  costInMicros,
  modellFuerWerkzeuge,
  standardModell,
  waehleAnbindung,
  zerlegeKennung,
} from "@/lib/models";

describe("zerlegeKennung", () => {
  it("trennt am ersten Schraegstrich", () => {
    expect(zerlegeKennung("anthropic/claude-sonnet-4-5")).toEqual({
      praefix: "anthropic",
      nativeId: "claude-sonnet-4-5",
    });
    expect(zerlegeKennung("openai/gpt-4o:extended")).toEqual({
      praefix: "openai",
      nativeId: "gpt-4o:extended",
    });
  });

  it("liefert ohne Schraegstrich einen leeren Praefix", () => {
    expect(zerlegeKennung("gpt-5-mini")).toEqual({ praefix: "", nativeId: "gpt-5-mini" });
  });

  it("das Kennungsmuster nimmt Anbieterformen an und weist Unsinn ab", () => {
    for (const gut of [
      "anthropic/claude-sonnet-4-5-20250929",
      "openai/gpt-5-mini",
      "google/gemini-2.5-flash",
      "openai/gpt-4o:extended",
      "meta/llama-3.1_70b",
    ]) {
      expect(gut).toMatch(KENNUNG_MUSTER);
    }
    for (const schlecht of ["gpt-5", "Anthropic/claude", "openai/", "/gpt", "openai/gpt 5", "a/b/c "]) {
      expect(schlecht).not.toMatch(KENNUNG_MUSTER);
    }
  });
});

describe("costInMicros mit Katalogpreisen", () => {
  // Die Betraege der drei Standardmodelle muessen mit der frueheren festen
  // Liste uebereinstimmen: Diese Zahlen standen vor dem Umbau in usage_events.
  const [flashLite, flash, gptMini] = STANDARD_MODELLE;

  it("rechnet Eingabe, Ausgabe und Cache-Treffer getrennt", () => {
    // 10.000 Eingabe (davon 4.000 gecacht), 2.000 Ausgabe bei 0,10 / 0,40 / 0,01 $
    // = 6.000*0,1 + 4.000*0,01 + 2.000*0,4 = 600 + 40 + 800 Mikro-Dollar
    expect(costInMicros(flashLite, { input: 10_000, output: 2_000, cached: 4_000 })).toBe(1_440);
    // 1 Mio. Eingabe, 1 Mio. Ausgabe = 0,30 + 2,50 $
    expect(costInMicros(flash, { input: 1_000_000, output: 1_000_000, cached: 0 })).toBe(
      2_800_000,
    );
    // 100.000 Eingabe, 50.000 Ausgabe = 0,025 + 0,10 $
    expect(costInMicros(gptMini, { input: 100_000, output: 50_000, cached: 0 })).toBe(125_000);
  });

  it("zaehlt gecachte Token nicht doppelt und wird bei Ueberhang nicht negativ", () => {
    expect(costInMicros(flashLite, { input: 100, output: 0, cached: 500 })).toBe(5);
  });

  it("liefert 0 fuer 0 Token", () => {
    expect(costInMicros(gptMini, { input: 0, output: 0, cached: 0 })).toBe(0);
  });

  it("nutzt die Preise des uebergebenen Eintrags, nicht einer Liste", () => {
    const eigenes = {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
    };
    // 1.000 Eingabe (500 gecacht), 100 Ausgabe = 0,0015 + 0,00015 + 0,0015 $
    expect(costInMicros(eigenes, { input: 1_000, output: 100, cached: 500 })).toBe(3_150);
  });
});

describe("standardModell und Werkzeughebung", () => {
  it("faellt bei unbekannter Kennung auf das Standardmodell", () => {
    expect(standardModell("gibt/es-nicht").id).toBe(DEFAULT_MODEL_ID);
    expect(standardModell("openai/gpt-5-mini").id).toBe("openai/gpt-5-mini");
  });

  it("hebt nur Gemini 2.5 Flash Lite", () => {
    expect(modellFuerWerkzeuge("google/gemini-2.5-flash-lite")).toBe("google/gemini-2.5-flash");
    expect(modellFuerWerkzeuge("openai/gpt-5-mini")).toBe("openai/gpt-5-mini");
    expect(modellFuerWerkzeuge("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("waehleAnbindung", () => {
  it("geht nur mit Key-Anbieter UND Key direkt", () => {
    expect(waehleAnbindung({ provider: "anthropic" }, true)).toBe("direkt");
    expect(waehleAnbindung({ provider: "openai" }, true)).toBe("direkt");
  });

  it("faellt ohne Key auf das Gateway zurueck", () => {
    expect(waehleAnbindung({ provider: "anthropic" }, false)).toBe("gateway");
    expect(waehleAnbindung({ provider: "openai" }, false)).toBe("gateway");
  });

  it("schickt Gateway-Modelle immer ueber das Gateway, auch mit Key", () => {
    expect(waehleAnbindung({ provider: "gateway" }, true)).toBe("gateway");
    expect(waehleAnbindung({ provider: "gateway" }, false)).toBe("gateway");
  });
});

describe("Gateway-Preise", () => {
  it("rechnet US-Dollar je Token auf je 1 Mio. Token um, ohne Gleitkommarest", () => {
    expect(preisJeMillion("0.0000001")).toBe(0.1);
    expect(preisJeMillion("0.0000025")).toBe(2.5);
    expect(preisJeMillion("0.000003")).toBe(3);
    expect(preisJeMillion("0.00000025")).toBe(0.25);
    expect(preisJeMillion(0.000015)).toBe(15);
  });

  it("weist Unbrauchbares ab", () => {
    expect(preisJeMillion(undefined)).toBeUndefined();
    expect(preisJeMillion("abc")).toBeUndefined();
    expect(preisJeMillion("-1")).toBeUndefined();
  });

  it("uebernimmt den Cache-Preis oder setzt ein Zehntel der Eingabe", () => {
    expect(
      preisAusGateway({ input: "0.000003", output: "0.000015", input_cache_read: "0.0000003" }),
    ).toEqual({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 });

    expect(preisAusGateway({ input: "0.00000025", output: "0.000002" })).toEqual({
      inputPerMillion: 0.25,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.025,
    });

    expect(preisAusGateway({ input: "0.000001" })).toBeUndefined();
    expect(preisAusGateway(undefined)).toBeUndefined();
  });

  it("liefert fuer die drei Standardmodelle dieselben Preise wie der Standardkatalog", () => {
    // Auszug aus GET https://ai-gateway.vercel.sh/v1/models vom 2. 9. 2026.
    const katalog: GatewayEintrag[] = [
      {
        id: "google/gemini-2.5-flash-lite",
        pricing: { input: "0.0000001", output: "0.0000004", input_cache_read: "0.00000001" },
      },
      {
        id: "google/gemini-2.5-flash",
        pricing: { input: "0.0000003", output: "0.0000025", input_cache_read: "0.00000003" },
      },
      {
        id: "openai/gpt-5-mini",
        pricing: { input: "0.00000025", output: "0.000002", input_cache_read: "0.000000025" },
      },
    ];

    for (const modell of STANDARD_MODELLE) {
      const { praefix, nativeId } = zerlegeKennung(modell.id);
      expect(ordnePreisZu(praefix, nativeId, katalog)).toEqual({
        inputPerMillion: modell.inputPerMillion,
        outputPerMillion: modell.outputPerMillion,
        cacheReadPerMillion: modell.cacheReadPerMillion,
      });
    }
  });
});

describe("tolerante Kennungs-Zuordnung", () => {
  const katalog: GatewayEintrag[] = [
    { id: "anthropic/claude-sonnet-4.5", pricing: { input: "0.000003", output: "0.000015" } },
    { id: "anthropic/claude-haiku-4.5", pricing: { input: "0.000001", output: "0.000005" } },
    { id: "openai/gpt-5-mini", pricing: { input: "0.00000025", output: "0.000002" } },
    { id: "openai/gpt-5", pricing: { input: "0.00000125", output: "0.00001" } },
  ];

  it("normalisiert Punkt, Bindestrich, Datumsanhaenge und -latest", () => {
    expect(normalisiereKennung("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalisiereKennung("claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(normalisiereKennung("gpt-5-mini-2025-08-07")).toBe("gpt-5-mini");
    expect(normalisiereKennung("claude-3-5-haiku-latest")).toBe("claude-3-5-haiku");
    expect(normalisiereKennung("GPT-5")).toBe("gpt-5");
  });

  it("findet Anthropic-Kennungen mit Bindestrich und Datum zum Gateway-Eintrag mit Punkt", () => {
    expect(ordnePreisZu("anthropic", "claude-sonnet-4-5-20250929", katalog)).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
    });
    expect(ordnePreisZu("anthropic", "claude-haiku-4-5", katalog)?.inputPerMillion).toBe(1);
  });

  it("findet OpenAI-Kennungen mit Datumsanhang und verwechselt gpt-5 nicht mit gpt-5-mini", () => {
    expect(ordnePreisZu("openai", "gpt-5-mini-2025-08-07", katalog)?.outputPerMillion).toBe(2);
    expect(ordnePreisZu("openai", "gpt-5", katalog)?.outputPerMillion).toBe(10);
    expect(ordnePreisZu("openai", "gpt-5-2025-08-07", katalog)?.inputPerMillion).toBe(1.25);
  });

  it("ordnet nicht ueber Anbietergrenzen hinweg zu und meldet Unbekanntes als undefined", () => {
    expect(ordnePreisZu("openai", "claude-sonnet-4-5", katalog)).toBeUndefined();
    expect(ordnePreisZu("anthropic", "claude-opus-9", katalog)).toBeUndefined();
  });
});
