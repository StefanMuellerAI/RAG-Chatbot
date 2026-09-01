import { beforeEach, describe, expect, it, vi } from "vitest";

// Ein Redis im Speicher — es geht hier um die Logik, nicht um Upstash.
const speicher = new Map<string, string>();
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => speicher.get(key) ?? null,
    set: async (key: string, value: string) => {
      speicher.set(key, value);
      return "OK";
    },
  }),
}));

import {
  SettingsIncompleteError,
  getPublicSettings,
  maskKey,
  resolveApiKey,
  resolveSettings,
  updateSettings,
} from "@/lib/settings";

const SECRET = "auth-secret-fuer-tests-0123456789abcdef";

beforeEach(() => {
  speicher.clear();
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

describe("maskKey", () => {
  it("zeigt Anfang und Ende, aber nie den ganzen Key", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop7f3a")).toBe("sk-ant-…7f3a");
    expect(maskKey("kurz")).toBe("••••");
  });
});

describe("Einstellungen", () => {
  it("liefert Standardwerte ohne gespeicherte Daten", async () => {
    const settings = await getPublicSettings();
    expect(settings).toMatchObject({ provider: "anthropic", model: "", dailyAnswerLimit: 200, updatedAt: null });
    expect(settings.keys).toEqual({});
  });

  it("zeigt den Umgebungs-Key als Rueckfallwert an", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-umgebungswert-1234-abcd");
    const settings = await getPublicSettings();
    expect(settings.keys.openai).toEqual({ masked: "sk-proj…abcd", source: "umgebung" });
    expect(settings.keys.anthropic).toBeUndefined();
  });

  it("speichert Keys verschluesselt und gibt sie nur maskiert zurueck", async () => {
    const settings = await updateSettings({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      dailyAnswerLimit: 50,
      keys: { anthropic: "sk-ant-api03-klartext-geheim-9z9z" },
    });

    expect(settings.keys.anthropic).toEqual({ masked: "sk-ant-…9z9z", source: "gespeichert" });
    const roh = speicher.get("settings:v1") ?? "";
    expect(roh).not.toContain("klartext");
    expect(roh).toContain("v1.");
  });

  it("behaelt einen Key, wenn er beim Speichern nicht mitgeschickt wird", async () => {
    await updateSettings({
      provider: "openai",
      model: "gpt-5",
      dailyAnswerLimit: 10,
      keys: { openai: "sk-proj-erster-wert-abcd-wxyz" },
    });
    const danach = await updateSettings({ provider: "openai", model: "gpt-5-mini", dailyAnswerLimit: 20 });

    expect(danach.model).toBe("gpt-5-mini");
    expect(danach.keys.openai?.masked).toBe("sk-proj…wxyz");
    expect(await resolveApiKey("openai")).toBe("sk-proj-erster-wert-abcd-wxyz");
  });

  it("loescht einen Key mit null", async () => {
    await updateSettings({
      provider: "openai",
      model: "gpt-5",
      dailyAnswerLimit: 10,
      keys: { openai: "sk-proj-loeschen-abcd-wxyz" },
    });
    const danach = await updateSettings({ provider: "openai", model: "gpt-5", dailyAnswerLimit: 10, keys: { openai: null } });
    expect(danach.keys.openai).toBeUndefined();
  });

  it("bevorzugt den frisch eingegebenen Key vor dem gespeicherten", async () => {
    await updateSettings({
      provider: "anthropic",
      model: "m",
      dailyAnswerLimit: 10,
      keys: { anthropic: "sk-ant-gespeichert-abcd-wxyz" },
    });
    expect(await resolveApiKey("anthropic", "  sk-ant-neu-eingegeben  ")).toBe("sk-ant-neu-eingegeben");
    expect(await resolveApiKey("anthropic", "   ")).toBe("sk-ant-gespeichert-abcd-wxyz");
  });

  it("verweigert den Chat ohne Modell oder ohne Key mit klarer Meldung", async () => {
    await expect(resolveSettings()).rejects.toBeInstanceOf(SettingsIncompleteError);
    await expect(resolveSettings()).rejects.toThrow(/Modell/);

    await updateSettings({ provider: "openai", model: "gpt-5", dailyAnswerLimit: 10 });
    await expect(resolveSettings()).rejects.toThrow(/OpenAI.*API-Key/);
  });

  it("loest den Chat-Aufruf mit entschluesseltem Key auf", async () => {
    await updateSettings({
      provider: "openai",
      model: "gpt-5",
      dailyAnswerLimit: 77,
      keys: { openai: "sk-proj-chat-key-abcd-wxyz" },
    });
    expect(await resolveSettings()).toEqual({
      provider: "openai",
      model: "gpt-5",
      apiKey: "sk-proj-chat-key-abcd-wxyz",
      dailyAnswerLimit: 77,
      dailyAnswerLimitPerUser: null,
    });
  });

  it("speichert ein Limit pro Nutzer und liefert es fuer den Chat", async () => {
    await updateSettings({
      provider: "openai",
      model: "gpt-5",
      dailyAnswerLimit: 100,
      dailyAnswerLimitPerUser: 5,
      keys: { openai: "sk-proj-chat-key-abcd-wxyz" },
    });
    expect((await resolveSettings()).dailyAnswerLimitPerUser).toBe(5);
    expect((await getPublicSettings()).dailyAnswerLimitPerUser).toBe(5);
  });
});
