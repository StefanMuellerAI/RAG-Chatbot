import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit laedt .env.local NICHT von selbst — nur Next.js tut das.
 * Migrationen deshalb ueber dotenv-cli aufrufen:
 *
 *   npm run db:generate
 *   npm run db:push
 */
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
