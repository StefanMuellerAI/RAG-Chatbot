/**
 * Fehlerklassen, die Route-Handler in HTTP-Status uebersetzen (siehe lib/api.ts).
 * Eigene Datei ohne Next-Abhaengigkeiten, damit Bibliotheken und Tests sie
 * ohne Request-Kontext importieren koennen.
 */

/** Eingabe des Aufrufers ist unbrauchbar (400). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Keine oder ungueltige Sitzung (401). */
export class UnauthorizedError extends Error {
  constructor(message = "Nicht angemeldet.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Angemeldet, aber nicht berechtigt (403). */
export class ForbiddenError extends Error {
  constructor(message = "Kein Zugriff auf diese Ressource.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Ressource existiert nicht (404). */
export class NotFoundError extends Error {
  constructor(message = "Nicht gefunden.") {
    super(message);
    this.name = "NotFoundError";
  }
}
