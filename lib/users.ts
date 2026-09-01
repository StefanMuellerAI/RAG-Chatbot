import { ADMIN_USER_ID } from "./auth";
import { deleteCollectionsOf } from "./collections";
import { ValidationError } from "./errors";
import { hashPassword } from "./password";
import { getRedis } from "./redis";

/**
 * Nutzerkonten in Redis.
 *
 *   users          Hash  userId -> User (JSON)
 *   users:byEmail  Hash  email (normalisiert) -> userId
 *
 * Der Admin ist kein Eintrag hier — er meldet sich mit ADMIN_PASSWORD an und
 * traegt die feste ID `admin`.
 */

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  disabled: boolean;
};

/** Ohne Passwort-Hash — die Form fuer Listen und den Browser. */
export type PublicUser = Omit<User, "passwordHash">;

const USERS_KEY = "users";
const BY_EMAIL_KEY = "users:byEmail";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: unknown): string {
  if (typeof email !== "string") throw new ValidationError("Bitte eine E-Mail-Adresse angeben.");
  const normalized = normalizeEmail(email);
  if (!EMAIL.test(normalized) || normalized.length > 254) {
    throw new ValidationError("Die E-Mail-Adresse sieht nicht gueltig aus.");
  }
  return normalized;
}

function parseUser(value: unknown): User | null {
  try {
    const user = (typeof value === "string" ? JSON.parse(value) : value) as User;
    return user && typeof user.id === "string" && typeof user.email === "string" ? user : null;
  } catch {
    return null;
  }
}

export function toPublic(user: User): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt, disabled: user.disabled };
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const redis = getRedis();
  const userId = await redis.hget<string>(BY_EMAIL_KEY, normalizeEmail(email));
  if (!userId) return null;
  return getUser(userId);
}

export async function getUser(userId: string): Promise<User | null> {
  const raw = await getRedis().hget<unknown>(USERS_KEY, userId);
  return raw ? parseUser(raw) : null;
}

export async function emailTaken(email: string): Promise<boolean> {
  return Boolean(await getRedis().hget<string>(BY_EMAIL_KEY, normalizeEmail(email)));
}

export async function createUser(email: string, password: string): Promise<PublicUser> {
  const normalized = assertValidEmail(email);
  if (await emailTaken(normalized)) {
    throw new ValidationError("Fuer diese E-Mail-Adresse gibt es bereits ein Konto.");
  }

  const user: User = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    disabled: false,
  };

  const redis = getRedis();
  await Promise.all([
    redis.hset(USERS_KEY, { [user.id]: JSON.stringify(user) }),
    redis.hset(BY_EMAIL_KEY, { [normalized]: user.id }),
  ]);
  return toPublic(user);
}

export async function listUsers(): Promise<PublicUser[]> {
  const all = await getRedis().hgetall<Record<string, unknown>>(USERS_KEY);
  if (!all) return [];
  return Object.values(all)
    .map(parseUser)
    .filter((user): user is User => user !== null)
    .map(toPublic)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<PublicUser | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const next: User = { ...user, disabled };
  await getRedis().hset(USERS_KEY, { [userId]: JSON.stringify(next) });
  return toPublic(next);
}

/** Loescht Konto und alle Sammlungen des Nutzers samt Dokumenten und Vektoren. */
export async function deleteUser(userId: string): Promise<boolean> {
  if (userId === ADMIN_USER_ID) throw new ValidationError("Der Administrator kann nicht geloescht werden.");

  const user = await getUser(userId);
  if (!user) return false;

  await deleteCollectionsOf(userId);

  const redis = getRedis();
  await Promise.all([redis.hdel(USERS_KEY, userId), redis.hdel(BY_EMAIL_KEY, user.email)]);
  return true;
}
