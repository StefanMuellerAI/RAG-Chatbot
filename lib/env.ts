/**
 * Zentraler, *fauler* Zugriff auf Environment-Variablen.
 *
 * Wichtig: Diese Datei liest niemals beim Import. Waehrend des Vercel-Builds
 * existieren die Variablen unter Umstaenden noch gar nicht — ein Zugriff auf
 * Modulebene wuerde den Build zum Absturz bringen, bevor man ueberhaupt
 * Gelegenheit hatte, die Keys zu hinterlegen. Stattdessen wird jeder Wert erst
 * im Request-Handler angefordert.
 *
 * Next.js (Webpack/Turbopack) ersetzt nur die Form `process.env.NAME` mit
 * festem Literal. `process.env[name]` sieht im Server-Bundle ein Objekt, in
 * dem nur Keys stehen, die irgendwo statisch vorkommen — der Rest wirkt
 * unset, obwohl Vercel die Werte zur Laufzeit injiziert. Deshalb muss jeder
 * von der App gelesene Name hier als Literal stehen.
 *
 * Marketplace-Aliase: Neon setzt oft POSTGRES_URL, Vercel-Storage-Redis
 * KV_REST_API_*, und auf Vercel authentifiziert das AI Gateway per OIDC
 * (`VERCEL_OIDC_TOKEN`) ohne eigenen Gateway-Schluessel.
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

function nichtLeer(wert: string | undefined): string | undefined {
  return wert && wert.length > 0 ? wert : undefined;
}

function read(name: string): string | undefined {
  switch (name) {
    case "DATABASE_URL":
      return (
        nichtLeer(process.env.DATABASE_URL) ??
        nichtLeer(process.env.POSTGRES_URL) ??
        nichtLeer(process.env.POSTGRES_PRISMA_URL)
      );
    case "AI_GATEWAY_API_KEY":
      return nichtLeer(process.env.AI_GATEWAY_API_KEY) ?? nichtLeer(process.env.VERCEL_OIDC_TOKEN);
    case "PINECONE_API_KEY":
      return nichtLeer(process.env.PINECONE_API_KEY);
    case "PINECONE_INDEX":
      return nichtLeer(process.env.PINECONE_INDEX);
    case "UPSTASH_REDIS_REST_URL":
      return nichtLeer(process.env.UPSTASH_REDIS_REST_URL) ?? nichtLeer(process.env.KV_REST_API_URL);
    case "UPSTASH_REDIS_REST_TOKEN":
      return (
        nichtLeer(process.env.UPSTASH_REDIS_REST_TOKEN) ?? nichtLeer(process.env.KV_REST_API_TOKEN)
      );
    case "BLOB_READ_WRITE_TOKEN":
      return nichtLeer(process.env.BLOB_READ_WRITE_TOKEN);
    case "CLERK_SECRET_KEY":
      return nichtLeer(process.env.CLERK_SECRET_KEY);
    case "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY":
      return nichtLeer(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    case "CLERK_WEBHOOK_SIGNING_SECRET":
      return nichtLeer(process.env.CLERK_WEBHOOK_SIGNING_SECRET);
    case "CRON_SECRET":
      return nichtLeer(process.env.CRON_SECRET);
    case "GLOBAL_QUESTIONS_PER_MINUTE":
      return nichtLeer(process.env.GLOBAL_QUESTIONS_PER_MINUTE);
    default:
      return nichtLeer(process.env[name]);
  }
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
 * Welche Variablen fuer welchen Bereich noetig sind.
 *
 * "chat" deckt den Frageweg ab, "collections" die Dokumentenverwaltung eines
 * Nutzers, "admin" zusaetzlich nichts weiter — der Admin-Bereich braucht nur
 * die Datenbank, weil Plaene und Groessenklassen dort liegen.
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
  auth: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
} as const;

export type Bereich = keyof typeof BEREICHE;

/** Namen aller Variablen, die fuer den jeweiligen Bereich fehlen. */
export function missingFor(area: Bereich): string[] {
  return BEREICHE[area].filter((name) => read(name) === undefined);
}
