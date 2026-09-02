import { beforeEach, describe, expect, it, vi } from "vitest";

// Die Tabelle provider_keys als Map im Speicher — geprueft wird die Logik
// (Verschluesseln, Maskieren, Zwischenspeichern), nicht Neon.
type Zeile = { provider: "anthropic" | "openai"; encrypted: string; masked: string; updatedAt: Date };
const tabelle = new Map<string, Zeile>();
let lesezugriffe = 0;

vi.mock("@/lib/provider-keys-speicher", () => ({
  ladeKeyZeile: async (provider: string) => {
    lesezugriffe += 1;
    return tabelle.get(provider) ?? null;
  },
  ladeKeyZeilen: async () => [...tabelle.values()],
  schreibeKeyZeile: async (zeile: Omit<Zeile, "updatedAt">) => {
    tabelle.set(zeile.provider, { ...zeile, updatedAt: new Date("2026-09-02T08:00:00Z") });
  },
  loescheKeyZeile: async (provider: string) => {
    tabelle.delete(provider);
  },
}));

import { MissingConfigError } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import {
  ladeKey,
  ladeKeyStatus,
  loescheKey,
  maskKey,
  pruefeKeyEingabe,
  speichereKey,
  verwirfKeyZwischenspeicher,
} from "@/lib/provider-keys";

const SECRET = "provider-key-secret-fuer-tests-0123456789abcdef";
const KEY = "sk-ant-api03-klartext-geheim-9z9z";

beforeEach(() => {
  tabelle.clear();
  lesezugriffe = 0;
  verwirfKeyZwischenspeicher();
  vi.stubEnv("PROVIDER_KEY_SECRET", SECRET);
});

describe("maskKey", () => {
  it("zeigt Anfang und Ende, aber nie den ganzen Key", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop7f3a")).toBe("sk-ant-…7f3a");
    expect(maskKey("kurz")).toBe("••••");
  });
});

describe("pruefeKeyEingabe", () => {
  it("trimmt und weist zu kurze oder leerzeichenhaltige Werte ab", () => {
    expect(pruefeKeyEingabe("  sk-proj-abcdefghijkl  ")).toBe("sk-proj-abcdefghijkl");
    expect(() => pruefeKeyEingabe("kurz")).toThrow(ValidationError);
    expect(() => pruefeKeyEingabe("sk-proj-abc def ghijkl")).toThrow(ValidationError);
    expect(() => pruefeKeyEingabe(42)).toThrow(ValidationError);
  });
});

describe("Anbieter-Keys", () => {
  it("speichert verschluesselt und legt nur die Maske daneben", async () => {
    await speichereKey("anthropic", KEY);

    const zeile = tabelle.get("anthropic")!;
    expect(zeile.encrypted.startsWith("v1.")).toBe(true);
    expect(zeile.encrypted).not.toContain("klartext");
    expect(zeile.masked).toBe("sk-ant-…9z9z");
  });

  it("gibt im Status nur Maske, Zeitpunkt und Lesbarkeit zurueck", async () => {
    await speichereKey("openai", "sk-proj-erster-wert-abcd-wxyz");

    const status = await ladeKeyStatus();
    expect(status.openai).toEqual({
      masked: "sk-proj…wxyz",
      updatedAt: "2026-09-02T08:00:00.000Z",
      lesbar: true,
    });
    expect(status.anthropic).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("erster-wert");
  });

  it("entschluesselt fuer den Modellaufruf und haelt den Wert eine Minute im Modul", async () => {
    await speichereKey("anthropic", KEY);

    expect(await ladeKey("anthropic")).toBe(KEY);
    expect(await ladeKey("anthropic")).toBe(KEY);
    expect(lesezugriffe).toBe(1);

    // Auch "kein Key" wird gehalten — sonst fragt jede Frage die Datenbank.
    expect(await ladeKey("openai")).toBeNull();
    expect(await ladeKey("openai")).toBeNull();
    expect(lesezugriffe).toBe(2);
  });

  it("loescht den Key und verwirft den Zwischenspeicher", async () => {
    await speichereKey("openai", "sk-proj-loeschen-abcd-wxyz");
    expect(await ladeKey("openai")).toBe("sk-proj-loeschen-abcd-wxyz");

    await loescheKey("openai");
    expect(await ladeKey("openai")).toBeNull();
    expect((await ladeKeyStatus()).openai).toBeUndefined();
  });

  it("ersetzt einen Key und liefert sofort den neuen", async () => {
    await speichereKey("anthropic", KEY);
    expect(await ladeKey("anthropic")).toBe(KEY);

    await speichereKey("anthropic", "sk-ant-api03-zweiter-wert-1a1a");
    expect(await ladeKey("anthropic")).toBe("sk-ant-api03-zweiter-wert-1a1a");
    expect((await ladeKeyStatus()).anthropic?.masked).toBe("sk-ant-…1a1a");
  });

  it("meldet ein gewechseltes Geheimnis als nicht lesbar statt zu raten", async () => {
    await speichereKey("anthropic", KEY);
    verwirfKeyZwischenspeicher();
    vi.stubEnv("PROVIDER_KEY_SECRET", "ein-anderes-geheimnis-0123456789");

    expect((await ladeKeyStatus()).anthropic?.lesbar).toBe(false);
    await expect(ladeKey("anthropic")).rejects.toThrow(/PROVIDER_KEY_SECRET/);
  });

  it("kann ohne PROVIDER_KEY_SECRET nichts speichern und nennt die Variable", async () => {
    vi.stubEnv("PROVIDER_KEY_SECRET", "");
    await expect(speichereKey("anthropic", KEY)).rejects.toBeInstanceOf(MissingConfigError);
    await expect(speichereKey("anthropic", KEY)).rejects.toThrow(/PROVIDER_KEY_SECRET/);
    expect(tabelle.size).toBe(0);
  });
});
