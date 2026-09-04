/**
 * Zentraler, *fauler* Zugriff auf Environment-Variablen.
 *
 * Wichtig: Diese Datei liest niemals beim Import. Waehrend des Vercel-Builds
 * existieren die Variablen unter Umstaenden noch gar nicht — ein Zugriff auf
 * Modulebene wuerde den Build zum Absturz bringen, bevor man ueberhaupt
 * Gelegenheit hatte, die Keys zu hinterlegen. Stattdessen wird jeder Wert erst
 * im Request-Handler angefordert.
 *
 * Zwei Lesewelten, die Next.js / Turbopack auseinanderreisst:
 *
 * 1. `process.env.NAME` mit festem Literal kann der Bundler zur Build-Zeit
 *    durch den damaligen Wert ersetzen. Fehlt der Key beim Build, steht dort
 *    dauerhaft leer — auch wenn Vercel ihn zur Laufzeit in die Funktion legt.
 * 2. `globalThis.process.env[name]` umgeht die Ersetzung und sieht das echte
 *    Node-Environment der laufenden Instanz.
 *
 * `roh()` nimmt beides. Marketplace-Aliase (Neon: POSTGRES_URL, Redis:
 * KV_REST_API_*) zaehlen fuer den kanonischen Namen mit.
 *
 * Das AI Gateway authentifiziert auf Vercel nicht ueber `VERCEL_OIDC_TOKEN` im
 * Environment — der Token liegt am Request-Header `x-vercel-oidc-token` und
 * wird von `@vercel/oidc` gelesen. `PINECONE_INDEX` faellt auf
 * `wissensassistent` zurueck, denselben Namen wie `npm run pinecone:init`.
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

/** Echtes Node-`process.env` der laufenden Instanz, ohne Turbopack-Ersetzung. */
function live(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: NodeJS.ProcessEnv } }).process?.env;
  return nichtLeer(env?.[name]);
}

/**
 * Statische Form, die Next.js kennt. Fallback, falls der Bundler den Wert
 * zur Build-Zeit eingesetzt hat und `globalThis.process.env` ihn nicht zeigt.
 */
function statisch(name: string): string | undefined {
  switch (name) {
    case "DATABASE_URL":
      return nichtLeer(process.env.DATABASE_URL);
    case "POSTGRES_URL":
      return nichtLeer(process.env.POSTGRES_URL);
    case "POSTGRES_PRISMA_URL":
      return nichtLeer(process.env.POSTGRES_PRISMA_URL);
    case "AI_GATEWAY_API_KEY":
      return nichtLeer(process.env.AI_GATEWAY_API_KEY);
    case "VERCEL_OIDC_TOKEN":
      return nichtLeer(process.env.VERCEL_OIDC_TOKEN);
    case "VERCEL":
      return nichtLeer(process.env.VERCEL);
    case "VERCEL_ENV":
      return nichtLeer(process.env.VERCEL_ENV);
    case "PINECONE_API_KEY":
      return nichtLeer(process.env.PINECONE_API_KEY);
    case "PINECONE_INDEX":
      return nichtLeer(process.env.PINECONE_INDEX);
    case "UPSTASH_REDIS_REST_URL":
      return nichtLeer(process.env.UPSTASH_REDIS_REST_URL);
    case "UPSTASH_REDIS_REST_TOKEN":
      return nichtLeer(process.env.UPSTASH_REDIS_REST_TOKEN);
    case "KV_REST_API_URL":
      return nichtLeer(process.env.KV_REST_API_URL);
    case "KV_REST_API_TOKEN":
      return nichtLeer(process.env.KV_REST_API_TOKEN);
    case "KV_URL":
      return nichtLeer(process.env.KV_URL);
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
    case "FALKORDB_URL":
      return nichtLeer(process.env.FALKORDB_URL);
    case "PROVIDER_KEY_SECRET":
      return nichtLeer(process.env.PROVIDER_KEY_SECRET);
    default:
      return undefined;
  }
}

function roh(name: string): string | undefined {
  return live(name) ?? statisch(name);
}

function read(name: string): string | undefined {
  switch (name) {
    case "DATABASE_URL":
      return roh("DATABASE_URL") ?? roh("POSTGRES_URL") ?? roh("POSTGRES_PRISMA_URL");
    case "AI_GATEWAY_API_KEY":
      return roh("AI_GATEWAY_API_KEY") ?? roh("VERCEL_OIDC_TOKEN");
    case "PINECONE_INDEX":
      return roh("PINECONE_INDEX") ?? "wissensassistent";
    case "UPSTASH_REDIS_REST_URL":
      return roh("UPSTASH_REDIS_REST_URL") ?? roh("KV_REST_API_URL") ?? roh("KV_URL");
    case "UPSTASH_REDIS_REST_TOKEN":
      return roh("UPSTASH_REDIS_REST_TOKEN") ?? roh("KV_REST_API_TOKEN");
    default:
      return roh(name);
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
 * Ist FalkorDB angebunden? Ohne FALKORDB_URL bleibt der Sammlungstyp "graph"
 * deaktiviert — alles andere laeuft unveraendert weiter.
 */
export function graphConfigured(): boolean {
  return read("FALKORDB_URL") !== undefined;
}

/**
 * Koennen Anbieter-Keys gespeichert werden? Ohne PROVIDER_KEY_SECRET gibt es
 * keinen Schluessel fuer die Verschluesselung — der Admin-Bereich zeigt dann
 * einen Hinweis, der Modellkatalog laeuft mit Gateway-Modellen weiter.
 */
export function providerKeySecretKonfiguriert(): boolean {
  return read("PROVIDER_KEY_SECRET") !== undefined;
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
export async function missingFor(area: Bereich): Promise<string[]> {
  const fehlt: string[] = [];
  for (const name of BEREICHE[area]) {
    if (name === "AI_GATEWAY_API_KEY") {
      if (!(await gatewayBereit())) fehlt.push(name);
    } else if (read(name) === undefined) {
      fehlt.push(name);
    }
  }
  return fehlt;
}

/**
 * Ist das AI Gateway erreichbar — per Schluessel, per Env-OIDC oder per
 * Request-Header auf Vercel? MP3-Transkription und der Chat brauchen das,
 * PDF-Extraktion nicht.
 *
 * Auf Vercel liegt der OIDC-Token am Request, nicht in process.env.
 * Lokal zaehlt AI_GATEWAY_API_KEY bzw. ein per `vercel env pull` geholtes
 * VERCEL_OIDC_TOKEN.
 */
export async function gatewayBereit(): Promise<boolean> {
  if (roh("AI_GATEWAY_API_KEY") || roh("VERCEL_OIDC_TOKEN")) return true;
  return (await oidcHeader()) !== undefined;
}

async function oidcHeader(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    return nichtLeer((await headers()).get("x-vercel-oidc-token") ?? undefined);
  } catch {
    return undefined;
  }
}

/**
 * Welche Keys diese Instanz wirklich sieht — nur Namen, keine Werte.
 *
 * Damit laesst sich unterscheiden: Variable in Vercel nur fuer Development
 * hinterlegt, anderer Name (POSTGRES_URL statt DATABASE_URL), oder der
 * Bundler hat den Build-Zeit-Wert leer eingesetzt.
 */
const DIAGNOSE_KEYS = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_OIDC_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "AI_GATEWAY_API_KEY",
  "PINECONE_API_KEY",
  "PINECONE_INDEX",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "KV_URL",
  "BLOB_READ_WRITE_TOKEN",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "FALKORDB_URL",
  "PROVIDER_KEY_SECRET",
] as const;

export type EnvDiagnose = {
  vercelEnv: string;
  gesetzt: string[];
  leer: string[];
};

export async function envDiagnose(): Promise<EnvDiagnose> {
  const gesetzt: string[] = [];
  const leer: string[] = [];
  for (const name of DIAGNOSE_KEYS) {
    if (roh(name)) gesetzt.push(name);
    else leer.push(name);
  }
  if (await oidcHeader()) gesetzt.push("x-vercel-oidc-token");
  else leer.push("x-vercel-oidc-token");
  return {
    vercelEnv: roh("VERCEL_ENV") ?? "unbekannt",
    gesetzt,
    leer,
  };
}
