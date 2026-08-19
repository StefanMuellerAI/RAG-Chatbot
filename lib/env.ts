/**
 * Zentraler, *fauler* Zugriff auf Environment-Variablen.
 *
 * Wichtig: Diese Datei liest niemals beim Import. Waehrend des Vercel-Builds
 * existieren die Variablen unter Umstaenden noch gar nicht — ein Zugriff auf
 * Modulebene wuerde den Build zum Absturz bringen, bevor man ueberhaupt
 * Gelegenheit hatte, die Keys zu hinterlegen. Stattdessen wird jeder Wert erst
 * im Request-Handler angefordert.
 */

export class MissingConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(
      `Fehlende Konfiguration: ${variables.join(", ")}. ` +
        `Bitte im Vercel-Projekt unter Settings -> Environment Variables hinterlegen und neu deployen.`,
    );
    this.name = "MissingConfigError";
    this.variables = variables;
  }
}

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Liest die genannten Variablen oder wirft mit einer verwertbaren Liste. */
export function requireEnv<const T extends readonly string[]>(
  ...names: T
): Record<T[number], string> {
  const missing: string[] = [];
  const result = {} as Record<string, string>;

  for (const name of names) {
    const value = read(name);
    if (value === undefined) {
      missing.push(name);
    } else {
      result[name] = value;
    }
  }

  if (missing.length > 0) throw new MissingConfigError(missing);
  return result as Record<T[number], string>;
}

/** Namen aller Variablen, die fuer den jeweiligen Bereich fehlen. */
export function missingFor(area: "chat" | "admin"): string[] {
  const needed =
    area === "chat"
      ? ["ANTHROPIC_API_KEY", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"]
      : [
          "UPSTASH_VECTOR_REST_URL",
          "UPSTASH_VECTOR_REST_TOKEN",
          "BLOB_READ_WRITE_TOKEN",
          "ADMIN_PASSWORD",
          "AUTH_SECRET",
        ];
  return needed.filter((name) => read(name) === undefined);
}
