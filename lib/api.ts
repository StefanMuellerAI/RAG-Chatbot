import { NotAdminError, NotSignedInError } from "./auth/user";
import { MissingConfigError } from "./env";
import { NotFoundError, QuotaError, RateLimitError, ValidationError } from "./errors";

export type Fehlerbild = {
  status: number;
  body: { error: string; code: string } & Record<string, unknown>;
  headers?: Record<string, string>;
};

/**
 * Einheitliche Abbildung von Fehlern auf HTTP-Antworten.
 *
 * An einer Stelle, weil sonst jede Route ihre eigene Zuordnung erfindet und
 * der Client am Ende Statuscodes vorfindet, auf die er nicht vorbereitet ist.
 */
export function errorResponse(error: unknown, userId?: string): Response {
  const bild = beschreibeFehler(error);
  protokolliere(bild, error, "einer API-Route", userId);
  return Response.json(bild.body, { status: bild.status, headers: bild.headers });
}

/**
 * Fehler ins Log — dieselbe Regel fuer Routen und Server Actions.
 */
export function protokolliere(
  { status, body }: Fehlerbild,
  error: unknown,
  ort: string,
  userId?: string,
): void {
  if (status >= 500) {
    console.error(`Unerwarteter Fehler in ${ort}:`, error);
  } else if (status === 429 || status === 409) {
    /**
     * Abweisungen strukturiert loggen.
     *
     * Nicht als Fehler — sie sind der bestimmungsgemaesse Betrieb. Aber ihre
     * Haeufigkeit ist die wichtigste Kennzahl im laufenden Betrieb: Steigt sie,
     * sind entweder die Kontingente zu knapp bemessen oder ein Konto verhaelt
     * sich auffaellig. In der Vercel-Observability laesst sich nach dem Praefix
     * filtern und nach Konto gruppieren.
     */
    console.log(
      JSON.stringify({
        ereignis: "abweisung",
        status,
        code: body.code,
        userId: userId ?? null,
      }),
    );
  }
}

/**
 * Ordnet einen Fehler Status, Meldung und Code zu. Exportiert, damit Server
 * Actions dieselben Meldungen liefern wie die Routen — nur als Rueckgabewert
 * statt als HTTP-Antwort.
 */
export function beschreibeFehler(error: unknown): Fehlerbild {
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
