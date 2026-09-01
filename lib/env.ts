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

/**
 * Upstash Redis kommt je nach Einrichtungsweg unter zwei Namenspaaren an:
 * direkt aus der Upstash-Konsole als UPSTASH_REDIS_REST_*, ueber den
 * Vercel-Marketplace als KV_REST_API_*. Beide werden akzeptiert.
 */
export function redisCredentials(): { url: string; token: string } | undefined {
  const url = read("UPSTASH_REDIS_REST_URL") ?? read("KV_REST_API_URL");
  const token = read("UPSTASH_REDIS_REST_TOKEN") ?? read("KV_REST_API_TOKEN");
  return url && token ? { url, token } : undefined;
}

/** Sammelname, unter dem fehlende Redis-Zugangsdaten gemeldet werden. */
export const REDIS_VARIABLES = "UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN";

/**
 * FalkorDB ist optional: ohne FALKORDB_URL gibt es keine Graph-Sammlungen,
 * alles andere laeuft unveraendert. Deshalb taucht die Variable nicht in
 * `missingFor` auf.
 */
export function graphConfigured(): boolean {
  return read("FALKORDB_URL") !== undefined;
}

/**
 * Namen aller Variablen, die fuer den jeweiligen Bereich fehlen.
 * Der API-Key des Modellanbieters gehoert bewusst nicht dazu: er wird im
 * Admin hinterlegt, die Umgebungsvariable ist nur noch ein Rueckfallwert.
 */
export function missingFor(area: "chat" | "admin"): string[] {
  const needed =
    area === "chat"
      ? ["UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN", "AUTH_SECRET"]
      : [
          "UPSTASH_VECTOR_REST_URL",
          "UPSTASH_VECTOR_REST_TOKEN",
          "BLOB_READ_WRITE_TOKEN",
          "ADMIN_PASSWORD",
          "AUTH_SECRET",
        ];
  const missing = needed.filter((name) => read(name) === undefined);
  if (!redisCredentials()) missing.push(REDIS_VARIABLES);
  return missing;
}
