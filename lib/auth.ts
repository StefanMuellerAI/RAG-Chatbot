/**
 * Minimale Session fuer den Admin-Bereich: ein HMAC-signiertes Cookie.
 *
 * Bewusst ohne Auth-Framework — es gibt genau ein Passwort und genau eine
 * Rolle. Alles laeuft ueber die Web-Crypto-API, damit derselbe Code auch in
 * der Edge-Runtime der Middleware funktioniert.
 */

export const SESSION_COOKIE = "rag_admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 Stunden

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
export async function createSessionToken(secret: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `admin.${expiresAt}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** Prueft Signatur und Ablaufzeitpunkt eines Cookie-Werts. */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token) return false;

  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;

  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);

  const [subject, expiresAtRaw] = payload.split(".");
  if (subject !== "admin") return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  return timingSafeEqual(signature, await sign(payload, secret));
}

/** Vergleicht das eingegebene Passwort zeitkonstant mit dem hinterlegten. */
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
