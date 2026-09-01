import { NextResponse } from "next/server";
import { ValidationError, errorResponse, readJson } from "@/lib/api";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { requireEnv } from "@/lib/env";
import { acceptInvite } from "@/lib/invites";
import { passwordProblem } from "@/lib/password";
import { clientIp, enforceLimits, tooManyRequests } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Einladung annehmen: Passwort setzen, Konto anlegen, direkt anmelden.
 * Oeffentlich erreichbar — der Token ist der Nachweis.
 */
export async function POST(request: Request) {
  try {
    const limit = await enforceLimits(clientIp(request), ["login"]);
    if (!limit.ok) return tooManyRequests(limit);

    const { token, password } = await readJson<{ token: unknown; password: unknown }>(request);
    if (typeof token !== "string" || !token) throw new ValidationError("Einladungs-Token fehlt.");

    const problem = passwordProblem(password);
    if (problem) throw new ValidationError(problem);

    const user = await acceptInvite(token, password as string);

    const { AUTH_SECRET } = requireEnv("AUTH_SECRET");
    const response = NextResponse.json({ ok: true, role: "user", user });
    response.cookies.set(
      SESSION_COOKIE,
      await createSessionToken(AUTH_SECRET, { role: "user", userId: user.id }),
      { ...sessionCookieOptions },
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
