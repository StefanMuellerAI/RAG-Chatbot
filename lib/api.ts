import { NextResponse } from "next/server";
import type { Session } from "./auth";
import { MissingConfigError } from "./env";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "./errors";
import { currentSession } from "./session";
import { SettingsIncompleteError } from "./settings";

export { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "./errors";

/** Einheitliche Fehlerantwort fuer alle API-Routen. */
export function errorResponse(error: unknown): NextResponse {
  const status = statusFor(error);
  const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
  return NextResponse.json({ error: message }, { status });
}

function statusFor(error: unknown): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof UnauthorizedError) return 401;
  if (error instanceof ForbiddenError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof MissingConfigError || error instanceof SettingsIncompleteError) return 503;
  return 500;
}

/** Liest den JSON-Body tolerant — ein kaputter Body ergibt ein leeres Objekt. */
export async function readJson<T extends object>(request: Request): Promise<Partial<T>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}

/**
 * Sitzung des Aufrufers. Der Proxy weist Unangemeldete bereits ab; die Route
 * braucht die Identitaet trotzdem, um Eigentum zu pruefen.
 */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.role !== "admin") throw new ForbiddenError("Nur fuer Administratoren.");
  return session;
}
