import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  checkPassword,
  createSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { MissingConfigError, requireEnv } from "@/lib/env";

export const runtime = "nodejs";

/** Anmeldung: Passwort pruefen und Sitzungs-Cookie setzen. */
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

  const { password } = (await request.json().catch(() => ({}))) as { password?: string };

  if (typeof password !== "string" || !(await checkPassword(password, env.ADMIN_PASSWORD))) {
    return NextResponse.json({ error: "Falsches Passwort." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(env.AUTH_SECRET), {
    ...sessionCookieOptions,
  });
  return response;
}

/** Abmeldung. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}
