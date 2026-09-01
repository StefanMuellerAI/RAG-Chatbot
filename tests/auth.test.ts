import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER_ID, checkPassword, createSessionToken, verifySessionToken } from "@/lib/auth";

const SECRET = "test-secret-mit-genug-laenge-0123456789";
const ADMIN = { role: "admin", userId: ADMIN_USER_ID } as const;
const NUTZER = { role: "user", userId: "6f1c2a0e-3d4b-4c5e-9f8a-1b2c3d4e5f60" } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("Sitzungs-Token", () => {
  it("traegt Rolle und Nutzer-ID und laesst sich verifizieren", async () => {
    expect(await verifySessionToken(await createSessionToken(SECRET, ADMIN), SECRET)).toEqual(ADMIN);
    expect(await verifySessionToken(await createSessionToken(SECRET, NUTZER), SECRET)).toEqual(NUTZER);
  });

  it("lehnt fremde Geheimnisse ab", async () => {
    const token = await createSessionToken(SECRET, ADMIN);
    expect(await verifySessionToken(token, "anderes-geheimnis")).toBeNull();
  });

  it("lehnt manipulierte Rollen ab", async () => {
    const token = await createSessionToken(SECRET, NUTZER);
    expect(await verifySessionToken(token.replace(/^user\./, "admin."), SECRET)).toBeNull();
  });

  it("lehnt manipulierte Nutzer-IDs ab", async () => {
    const token = await createSessionToken(SECRET, NUTZER);
    const [role, , exp, sig] = token.split(".");
    expect(await verifySessionToken(`${role}.${ADMIN_USER_ID}.${exp}.${sig}`, SECRET)).toBeNull();
  });

  it("lehnt unbekannte Rollen selbst mit gueltiger Signatur-Form ab", async () => {
    const token = await createSessionToken(SECRET, ADMIN);
    const [, userId, exp, sig] = token.split(".");
    expect(await verifySessionToken(`root.${userId}.${exp}.${sig}`, SECRET)).toBeNull();
  });

  it("lehnt abgelaufene Token ab", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await createSessionToken(SECRET, ADMIN);
    vi.setSystemTime(new Date("2026-01-01T13:00:00Z"));
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("lehnt Muell und Token des alten Formats ab", async () => {
    expect(await verifySessionToken(undefined, SECRET)).toBeNull();
    expect(await verifySessionToken("", SECRET)).toBeNull();
    expect(await verifySessionToken("admin", SECRET)).toBeNull();
    expect(await verifySessionToken("admin.1700000000000.abc", SECRET)).toBeNull();
  });

  it("verweigert Nutzer-IDs mit Punkten, weil sie das Token zerlegen wuerden", async () => {
    await expect(createSessionToken(SECRET, { role: "user", userId: "a.b" })).rejects.toThrow();
  });
});

describe("checkPassword", () => {
  it("vergleicht exakt", async () => {
    expect(await checkPassword("geheim", "geheim")).toBe(true);
    expect(await checkPassword("geheim ", "geheim")).toBe(false);
    expect(await checkPassword("Geheim", "geheim")).toBe(false);
    expect(await checkPassword("", "geheim")).toBe(false);
  });
});
