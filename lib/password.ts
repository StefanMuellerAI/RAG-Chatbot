import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Passwort-Hashing fuer Nutzerkonten. Nur in der Node-Runtime verwenden
 * (Route-Handler); der Proxy prueft ausschliesslich signierte Sitzungen.
 *
 * Format: `scrypt$<salt>$<hash>` (jeweils base64url).
 */

const KEY_LENGTH = 64;
// N=2^15 und r=8 brauchen 128*N*r = 32 MiB — ueber dem Node-Standard von 32 MiB.
const PARAMS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, PARAMS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "./password-rules";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltRaw, hashRaw] = stored.split("$");
  if (scheme !== "scrypt" || !saltRaw || !hashRaw) return false;

  const expected = Buffer.from(hashRaw, "base64url");
  if (expected.length === 0) return false;

  const actual = await scrypt(password, Buffer.from(saltRaw, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}
