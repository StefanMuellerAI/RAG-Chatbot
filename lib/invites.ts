import { base64UrlEncode } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { getRedis } from "./redis";
import { assertValidEmail, createUser, emailTaken, type PublicUser } from "./users";

/**
 * Einladungen: der Admin erzeugt einen Link, der Eingeladene setzt darueber
 * sein Passwort. Kein Mailversand — der Link wird kopiert.
 *
 *   invites  Hash  sha256(token) -> Invite (JSON)
 *
 * Gespeichert wird nur der Hash des Tokens. Wer Redis lesen kann, kann damit
 * keine Einladung annehmen.
 */

export type Invite = {
  /** Der Token-Hash — dient zugleich als Kennung fuer Liste und Widerruf. */
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
};

const INVITES_KEY = "invites";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function tokenId(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncode(new Uint8Array(hash));
}

function parseInvite(value: unknown): Invite | null {
  try {
    const invite = (typeof value === "string" ? JSON.parse(value) : value) as Invite;
    return invite && typeof invite.id === "string" && typeof invite.email === "string" ? invite : null;
  } catch {
    return null;
  }
}

function expired(invite: Invite): boolean {
  return Date.parse(invite.expiresAt) < Date.now();
}

export async function createInvite(email: unknown): Promise<{ token: string; invite: Invite }> {
  const normalized = assertValidEmail(email);
  if (await emailTaken(normalized)) {
    throw new ValidationError("Fuer diese E-Mail-Adresse gibt es bereits ein Konto.");
  }

  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const invite: Invite = {
    id: await tokenId(token),
    email: normalized,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };

  await getRedis().hset(INVITES_KEY, { [invite.id]: JSON.stringify(invite) });
  return { token, invite };
}

/** Offene Einladungen; abgelaufene werden dabei entfernt. */
export async function listInvites(): Promise<Invite[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(INVITES_KEY);
  if (!all) return [];

  const invites = Object.values(all)
    .map(parseInvite)
    .filter((invite): invite is Invite => invite !== null);

  const abgelaufen = invites.filter(expired).map((invite) => invite.id);
  if (abgelaufen.length > 0) await getRedis().hdel(INVITES_KEY, ...abgelaufen);

  return invites
    .filter((invite) => !expired(invite))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeInvite(id: string): Promise<boolean> {
  return (await getRedis().hdel(INVITES_KEY, id)) > 0;
}

/** Die Einladung zu einem Token — nur wenn sie existiert und noch gueltig ist. */
export async function getInviteByToken(token: string): Promise<Invite | null> {
  if (!token || token.length > 128) return null;
  const raw = await getRedis().hget<unknown>(INVITES_KEY, await tokenId(token));
  const invite = raw ? parseInvite(raw) : null;
  return invite && !expired(invite) ? invite : null;
}

/** Legt das Konto an und verbraucht die Einladung. */
export async function acceptInvite(token: string, password: string): Promise<PublicUser> {
  const invite = await getInviteByToken(token);
  if (!invite) throw new NotFoundError("Diese Einladung ist ungueltig oder abgelaufen.");

  const user = await createUser(invite.email, password);
  await getRedis().hdel(INVITES_KEY, invite.id);
  return user;
}
