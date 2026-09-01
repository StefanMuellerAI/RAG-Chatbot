import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";

describe("Passwort-Hashing", () => {
  it("erkennt das richtige Passwort und lehnt falsche ab", async () => {
    const hash = await hashPassword("korrektes-passwort-123");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("korrektes");
    expect(await verifyPassword("korrektes-passwort-123", hash)).toBe(true);
    expect(await verifyPassword("korrektes-passwort-124", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salzt — gleiche Passwoerter ergeben verschiedene Hashes", async () => {
    const a = await hashPassword("gleiches-passwort");
    const b = await hashPassword("gleiches-passwort");
    expect(a).not.toBe(b);
    expect(await verifyPassword("gleiches-passwort", a)).toBe(true);
    expect(await verifyPassword("gleiches-passwort", b)).toBe(true);
  });

  it("lehnt fremde oder kaputte Hash-Formate ab statt zu werfen", async () => {
    expect(await verifyPassword("x", "bcrypt$abc$def")).toBe(false);
    expect(await verifyPassword("x", "scrypt$$")).toBe(false);
    expect(await verifyPassword("x", "unsinn")).toBe(false);
  });
});

describe("passwordProblem", () => {
  it("verlangt Mindestlaenge und begrenzt die Maximallaenge", () => {
    expect(passwordProblem(undefined)).toMatch(/eingeben/);
    expect(passwordProblem("kurz")).toMatch(/mindestens/);
    expect(passwordProblem("a".repeat(10))).toBeNull();
    expect(passwordProblem("a".repeat(600))).toMatch(/zu lang/);
  });
});
