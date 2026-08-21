import { missingFor, requireEnv, MissingConfigError, envDiagnose } from "../lib/env";

/**
 * Pruefung der Environment-Erkennung.
 *
 *   npm run pruefe:env
 *
 * Die Chat-Seite zeigte gesetzte Vercel-Variablen als fehlend, weil
 * `process.env[name]` im Next-Bundle leer bleibt, Marketplace-Integrationen
 * andere Namen setzen, und der OIDC-Token auf Vercel im Request-Header
 * liegt statt in process.env. Die Faelle unten halten das fest.
 */

const SCHLUESSEL = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "PINECONE_API_KEY",
  "PINECONE_INDEX",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
] as const;

const original: Record<string, string | undefined> = {};
for (const name of SCHLUESSEL) original[name] = process.env[name];

function setzen(werte: Record<string, string | undefined>): void {
  for (const name of SCHLUESSEL) delete process.env[name];
  for (const [name, wert] of Object.entries(werte)) {
    if (wert === undefined) delete process.env[name];
    else process.env[name] = wert;
  }
}

let fehler = 0;

function pruefe(bezeichnung: string, bedingung: boolean, zusatz = ""): void {
  if (bedingung) {
    console.log(`  OK      ${bezeichnung}`);
  } else {
    console.error(`  FEHLER  ${bezeichnung}${zusatz ? ` — ${zusatz}` : ""}`);
    fehler += 1;
  }
}

async function main() {
console.log("\nEnvironment-Erkennung");

setzen({});
const chatLeer = await missingFor("chat");
pruefe(
  "ohne Werte fehlen DB, Gateway, Pinecone-Key und Redis — Index hat Default",
  chatLeer.join(",") ===
    "DATABASE_URL,AI_GATEWAY_API_KEY,PINECONE_API_KEY,UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN",
  chatLeer.join(","),
);

setzen({ POSTGRES_URL: "postgres://neon.example/db" });
pruefe("Neon-Alias POSTGRES_URL gilt als DATABASE_URL", (await missingFor("admin")).length === 0);

setzen({ POSTGRES_PRISMA_URL: "postgres://neon.example/prisma" });
pruefe(
  "Neon-Alias POSTGRES_PRISMA_URL gilt als DATABASE_URL",
  (await missingFor("admin")).length === 0,
);

setzen({ DATABASE_URL: "" });
pruefe(
  "leere DATABASE_URL zaehlt als fehlend",
  (await missingFor("admin")).includes("DATABASE_URL"),
);

setzen({ VERCEL_OIDC_TOKEN: "oidc-token" });
pruefe(
  "OIDC-Env erfuellt AI_GATEWAY_API_KEY",
  !(await missingFor("chat")).includes("AI_GATEWAY_API_KEY"),
);

setzen({
  KV_REST_API_URL: "https://example.upstash.io",
  KV_REST_API_TOKEN: "kv-token",
});
const chatKv = await missingFor("chat");
pruefe(
  "Vercel-Storage-Redis KV_REST_API_* gilt als Upstash",
  !chatKv.includes("UPSTASH_REDIS_REST_URL") && !chatKv.includes("UPSTASH_REDIS_REST_TOKEN"),
);

setzen({ POSTGRES_URL: "postgres://neon.example/db" });
const env = requireEnv("DATABASE_URL");
pruefe(
  "requireEnv liefert den Alias-Wert unter dem kanonischen Namen",
  env.DATABASE_URL === "postgres://neon.example/db",
);

setzen({});
pruefe(
  "PINECONE_INDEX faellt auf wissensassistent zurueck",
  requireEnv("PINECONE_INDEX").PINECONE_INDEX === "wissensassistent",
);

setzen({});
let geworfen: string[] | undefined;
try {
  requireEnv("DATABASE_URL");
} catch (error) {
  if (error instanceof MissingConfigError) geworfen = error.variables;
}
pruefe(
  "requireEnv nennt die fehlende Variable",
  geworfen?.join(",") === "DATABASE_URL",
  geworfen?.join(","),
);

setzen({ POSTGRES_URL: "postgres://neon.example/db", PINECONE_API_KEY: "pc-key" });
const diagnose = await envDiagnose();
pruefe(
  "Diagnose listet den Roh-Namen POSTGRES_URL, nicht den Alias DATABASE_URL",
  diagnose.gesetzt.includes("POSTGRES_URL") && diagnose.leer.includes("DATABASE_URL"),
  `gesetzt=${diagnose.gesetzt.join(",")} leer=${diagnose.leer.join(",")}`,
);
pruefe("Diagnose sieht PINECONE_API_KEY", diagnose.gesetzt.includes("PINECONE_API_KEY"));
pruefe(
  "Diagnose listet den OIDC-Header-Namen, auch wenn er hier fehlt",
  diagnose.leer.includes("x-vercel-oidc-token"),
);

for (const name of SCHLUESSEL) {
  const wert = original[name];
  if (wert === undefined) delete process.env[name];
  else process.env[name] = wert;
}

if (fehler > 0) {
  console.error(`\n${fehler} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}
console.log("\nAlle Environment-Pruefungen bestanden.\n");
}

void main();
