/**
 * Passwortregeln ohne Server-Abhaengigkeiten — gelten im Formular wie in der
 * Route, damit beide dieselbe Meldung liefern.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 512;

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Bitte ein Passwort eingeben.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return "Das Passwort ist zu lang.";
  return null;
}
