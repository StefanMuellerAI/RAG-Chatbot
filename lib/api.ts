import { NotAdminError, NotSignedInError } from "./auth/user";
import { MissingConfigError } from "./env";
import { NotFoundError, QuotaError, RateLimitError, ValidationError } from "./errors";

/**
 * Einheitliche Abbildung von Fehlern auf HTTP-Antworten.
 *
 * An einer Stelle, weil sonst jede Route ihre eigene Zuordnung erfindet und
 * der Client am Ende Statuscodes vorfindet, auf die er nicht vorbereitet ist.
 */
export function errorResponse(error: unknown): Response {
  const { status, body, headers } = zuordnen(error);

  // Unerwartete Fehler gehoeren ins Log, damit sie in der Vercel-Observability
  // auftauchen. Erwartete nicht — sonst ist das Log voll mit Kontingentmeldungen.
  if (status >= 500) console.error("Unerwarteter Fehler in einer API-Route:", error);

  return Response.json(body, { status, headers });
}

function zuordnen(error: unknown): {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
} {
  if (error instanceof NotSignedInError) {
    return { status: 401, body: { error: error.message, code: "nicht_angemeldet" } };
  }

  if (error instanceof NotAdminError) {
    return { status: 403, body: { error: error.message, code: "kein_admin" } };
  }

  if (error instanceof NotFoundError) {
    return { status: 404, body: { error: error.message, code: "nicht_gefunden" } };
  }

  if (error instanceof ValidationError) {
    return { status: 400, body: { error: error.message, code: "ungueltig" } };
  }

  if (error instanceof QuotaError) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: "kontingent",
        current: error.current,
        limit: error.limit,
      },
    };
  }

  if (error instanceof RateLimitError) {
    return {
      status: 429,
      body: { error: error.message, code: "zu_viele_anfragen" },
      headers: { "Retry-After": String(error.retryAfterSeconds) },
    };
  }

  // Fehlende Konfiguration ist kein Programmfehler, sondern ein Betriebszustand:
  // 503 mit der Liste der fehlenden Variablen ist verwertbar, 500 waere es nicht.
  if (error instanceof MissingConfigError) {
    return {
      status: 503,
      body: { error: error.message, code: "konfiguration", variables: error.variables },
    };
  }

  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : "Unbekannter Fehler.",
      code: "unbekannt",
    },
  };
}

/** Liest den JSON-Body und wirft eine verwertbare Meldung statt eines Syntaxfehlers. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ValidationError("Der Anfragekoerper ist kein gueltiges JSON.");
  }
}
