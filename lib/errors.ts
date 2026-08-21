/**
 * Fehlerarten, die die Oberflaeche unterschiedlich behandeln muss.
 *
 * Der Sinn eigener Klassen ist nicht Ordnung um ihrer selbst willen: In
 * lib/api.ts entscheidet der Typ ueber den HTTP-Status, und der Client
 * unterscheidet daran, ob er eine Meldung anzeigt, zur Anmeldung schickt oder
 * auf ein erhoehtes Kontingent verweist.
 */

/** Kontingent erschoepft — Plan- oder Groessenklassengrenze erreicht. */
export class QuotaError extends Error {
  readonly limit: number;
  readonly current: number;

  constructor(message: string, current: number, limit: number) {
    super(message);
    this.name = "QuotaError";
    this.current = current;
    this.limit = limit;
  }
}

/** Zu viele Anfragen in kurzer Zeit. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Zu viele Anfragen in kurzer Zeit. Bitte in ${retryAfterSeconds} Sekunden erneut versuchen.`,
    );
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Nicht gefunden — oder nicht dem Aufrufer zugehoerig.
 *
 * Beides fuehrt bewusst zur gleichen Meldung. Wer eine fremde ID errät, soll
 * nicht daran erkennen koennen, dass sie existiert.
 */
export class NotFoundError extends Error {
  constructor(was = "Der angeforderte Eintrag") {
    super(`${was} wurde nicht gefunden.`);
    this.name = "NotFoundError";
  }
}

/** Fehlerhafte Eingabe des Clients. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Lesbare Meldung aus einem unbekannten Fehler.
 *
 * Workflow-Schritte liefern FatalError nach der Serialisierung oft als
 * schlichtes Objekt. Dann greift `instanceof Error` nicht — die eigentliche
 * Meldung steht aber weiter in `message`. Ohne diesen Zugriff zeigte die
 * Oberflaeche nur "Unbekannter Fehler.", obwohl der Ablauf den Grund kannte.
 */
export function fehlerMeldung(
  error: unknown,
  fallback = "Unbekannter Fehler.",
): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;

  if (error && typeof error === "object") {
    const meldung = (error as { message?: unknown }).message;
    if (typeof meldung === "string" && meldung.trim()) return meldung;
  }

  return fallback;
}
