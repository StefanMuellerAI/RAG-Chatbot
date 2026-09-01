import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api";
import {
  ADMIN_USER_ID,
  SESSION_COOKIE,
  checkPassword,
  createSessionToken,
  sessionCookieOptions,
  type Session,
} from "@/lib/auth";
import { MissingConfigError, requireEnv } from "@/lib/env";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clientIp, enforceLimits, tooManyRequests } from "@/lib/ratelimit";
import { findUserByEmail } from "@/lib/users";

export const runtime = "nodejs";

const FALSCHES_PASSWORT = "E-Mail oder Passwort ist falsch.";

/**
 * Anmeldung.
 * - Ohne `email`: Administrator mit ADMIN_PASSWORD -> Rolle `admin`.
 * - Mit `email`: Nutzerkonto aus Redis -> Rolle `user`.
 */
export async function POST(request: Request) {
  let env;
  try {
    env = requireEnv("ADMIN_PASSWORD", "AUTH_SECRET");
  } catch (error) {
    if (error instanceof MissingConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  try {
    const limit = await enforceLimits(clientIp(request), ["login"]);
    if (!limit.ok) return tooManyRequests(limit);
  } catch (error) {
    return errorResponse(error);
  }

  const { email, password } = await readJson<{ email: unknown; password: unknown }>(request);
  if (typeof password !== "string" || password.length === 0 || password.length > 512) {
    return NextResponse.json({ error: FALSCHES_PASSWORT }, { status: 401 });
  }

  let session: Session | null;
  try {
    session =
      typeof email === "string" && email.trim().length > 0
        ? await nutzerAnmeldung(email, password)
        : await adminAnmeldung(password, env.ADMIN_PASSWORD);
  } catch (error) {
    return errorResponse(error);
  }

  if (!session) {
    return NextResponse.json({ error: FALSCHES_PASSWORT }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, role: session.role });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(env.AUTH_SECRET, session), {
    ...sessionCookieOptions,
  });
  return response;
}

async function adminAnmeldung(password: string, adminPassword: string): Promise<Session | null> {
  return (await checkPassword(password, adminPassword)) ? { role: "admin", userId: ADMIN_USER_ID } : null;
}

async function nutzerAnmeldung(email: string, password: string): Promise<Session | null> {
  const user = await findUserByEmail(email);

  if (!user) {
    // Gleiche Rechenzeit wie ein echter Vergleich, damit die Antwortdauer
    // nicht verraet, welche E-Mail-Adressen ein Konto haben.
    await hashPassword(password);
    return null;
  }

  const passt = await verifyPassword(password, user.passwordHash);
  if (!passt || user.disabled) return null;

  return { role: "user", userId: user.id };
}

/** Abmeldung. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}
