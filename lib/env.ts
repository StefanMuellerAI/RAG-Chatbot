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

/** Liest eine optionale Variable, ohne zu werfen. */
export function optionalEnv(name: string): string | undefined {
  return read(name);
}

/**
 * Sind die Clerk-Schluessel da?
 *
 * Der Zugriff ist hier ausgeschrieben und laeuft ausdruecklich NICHT ueber
 * `requireEnv`, und dafuer gibt es einen belegten Grund.
 *
 * Clerk liest den Publishable Key selbst wortwoertlich als
 * `process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (siehe
 * @clerk/nextjs/server/constants). Next.js ersetzt einen solchen
 * wortwoertlichen Zugriff beim Build durch den Wert, sofern er zum Buildzeitpunkt
 * gesetzt ist; fehlt er, bleibt der Zugriff stehen und wird zur Laufzeit
 * aufgeloest. Ein dynamischer Zugriff wie `process.env[name]` — so arbeitet
 * `requireEnv` — wird nie ersetzt und liest immer die Laufzeitumgebung.
 *
 * Damit koennen beide Wege auseinanderfallen: Wurde beim Build gesetzt und zur
 * Laufzeit nicht, sieht der wortwoertliche Zugriff den Wert und der dynamische
 * nicht. Clerk sieht in diesem Fall den Wert und funktioniert. Eine Pruefung
 * ueber `requireEnv` wuerde hier faelschlich Alarm schlagen.
 *
 * Diese Funktion liest deshalb genauso wie Clerk — dann stimmt ihre Antwort mit
 * dem ueberein, was Clerk tatsaechlich vorfindet.
 */
export function clerkKonfigurationFehlt(): string[] {
  const fehlt: string[] = [];

  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    fehlt.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  }
  if (!process.env.CLERK_SECRET_KEY) {
    fehlt.push("CLERK_SECRET_KEY");
  }

  return fehlt;
}

/**
 * Welche Variablen fuer welchen Bereich noetig sind.
 *
 * "chat" deckt den Frageweg ab, "collections" die Dokumentenverwaltung eines
 * Nutzers, "admin" zusaetzlich nichts weiter — der Admin-Bereich braucht nur
 * die Datenbank, weil Plaene und Groessenklassen dort liegen.
 *
 * Die Clerk-Schluessel stehen hier NICHT: Sie brauchen die wortwoertliche
 * Pruefung von `clerkKonfigurationFehlt` und wuerden hier falsch beantwortet.
 */
const BEREICHE = {
  chat: [
    "DATABASE_URL",
    "AI_GATEWAY_API_KEY",
    "PINECONE_API_KEY",
    "PINECONE_INDEX",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ],
  collections: [
    "DATABASE_URL",
    "PINECONE_API_KEY",
    "PINECONE_INDEX",
    "BLOB_READ_WRITE_TOKEN",
  ],
  admin: ["DATABASE_URL"],
} as const;

export type Bereich = keyof typeof BEREICHE;

/** Namen aller Variablen, die fuer den jeweiligen Bereich fehlen. */
export function missingFor(area: Bereich): string[] {
  return BEREICHE[area].filter((name) => read(name) === undefined);
}
