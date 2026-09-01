import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, decryptSecret, encryptSecret } from "@/lib/crypto";

const SECRET = "auth-secret-fuer-tests-0123456789abcdef";

describe("base64url", () => {
  it("kodiert hin und zurueck, auch bei Laengen ohne Padding-Rest", () => {
    for (const laenge of [0, 1, 2, 3, 4, 5, 12, 31, 32, 33]) {
      const bytes = new Uint8Array(laenge).map((_, i) => (i * 37 + 11) % 256);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("verwendet keine URL-unsicheren Zeichen", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64UrlEncode(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("stellt den Klartext wieder her", async () => {
    const chiffrat = await encryptSecret("sk-ant-api03-sehr-geheim", SECRET);
    expect(chiffrat.startsWith("v1.")).toBe(true);
    expect(chiffrat).not.toContain("geheim");
    expect(await decryptSecret(chiffrat, SECRET)).toBe("sk-ant-api03-sehr-geheim");
  });

  it("erzeugt fuer denselben Klartext verschiedene Chiffrate (zufaellige IV)", async () => {
    const a = await encryptSecret("gleich", SECRET);
    const b = await encryptSecret("gleich", SECRET);
    expect(a).not.toBe(b);
  });

  it("scheitert mit verwertbarer Meldung bei falschem Geheimnis", async () => {
    const chiffrat = await encryptSecret("wert", SECRET);
    await expect(decryptSecret(chiffrat, "anderes-geheimnis")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("scheitert bei manipuliertem Chiffrat", async () => {
    const chiffrat = await encryptSecret("wert", SECRET);
    const [v, iv, data] = chiffrat.split(".");
    const kaputt = `${v}.${iv}.${data.slice(0, -2)}AA`;
    await expect(decryptSecret(kaputt, SECRET)).rejects.toThrow();
  });

  it("lehnt unbekannte Formate ab", async () => {
    await expect(decryptSecret("v9.abc.def", SECRET)).rejects.toThrow(/Format/);
    await expect(decryptSecret("nix", SECRET)).rejects.toThrow(/Format/);
  });

  it("trennt Verwendungszwecke", async () => {
    const chiffrat = await encryptSecret("wert", SECRET, "zweck-a");
    await expect(decryptSecret(chiffrat, SECRET, "zweck-b")).rejects.toThrow();
  });
});
