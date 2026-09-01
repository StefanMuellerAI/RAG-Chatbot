import { base64UrlEncode } from "./crypto";

/**
 * Minimale Sessions: ein HMAC-signiertes Cookie mit Rolle, Nutzer-ID und
 * Ablaufzeit.
 *
 * Zwei Rollen reichen: `admin` (Einstellungen, Nutzer, alle Sammlungen) und
 * `user` (eigene Sammlungen, Chat). Der Admin hat die feste Nutzer-ID
 * `admin`. Alles laeuft ueber die Web-Crypto-API, damit derselbe Code auch in
 * der Edge-Runtime des Proxys funktioniert.
 */

export const SESSION_COOKIE = "rag_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 Stunden

export type Role = "admin" | "user";

export type Session = {
  role: Role;
  userId: string;
};

export const ADMIN_USER_ID = "admin";

const ROLES: readonly Role[] = ["admin", "user"];

/** Nutzer-IDs sind UUIDs oder `admin` — Punkte sind ausgeschlossen, sie trennen das Token. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const encoder = new TextEncoder();

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Zeitkonstanter Vergleich — verhindert, dass die Laufzeit das Geheimnis verraet. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Erzeugt den Cookie-Wert fuer eine frische Sitzung. */
export async function createSessionToken(secret: string, session: Session): Promise<string> {
  if (!USER_ID.test(session.userId)) throw new Error("Ungueltige Nutzer-ID fuer die Sitzung.");
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${session.role}.${session.userId}.${expiresAt}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/**
 * Prueft Signatur und Ablaufzeitpunkt eines Cookie-Werts.
 * Liefert die Sitzung, oder `null` wenn das Token ungueltig ist.
 */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<Session | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [role, userId, expiresAtRaw, signature] = parts;

  if (!(ROLES as readonly string[]).includes(role)) return null;
  if (!USER_ID.test(userId)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  const payload = `${role}.${userId}.${expiresAtRaw}`;
  if (!timingSafeEqual(signature, await sign(payload, secret))) return null;

  return { role: role as Role, userId };
}

/** Vergleicht das eingegebene Passwort zeitkonstant mit dem hinterlegten Klartext (Admin). */
export async function checkPassword(input: string, expected: string): Promise<boolean> {
  // Ueber die Hashes vergleichen, damit unterschiedliche Laengen nicht
  // schon durch die Laufzeit des Vergleichs auffallen.
  const [a, b] = await Promise.all([digest(input), digest(expected)]);
  return timingSafeEqual(a, b);
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(hash));
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;
