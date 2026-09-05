import { drizzle as postgresDrizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import * as schema from "@/lib/db/schema";

type QueryBuilder = { _prepare(): unknown };

export const TEST_CHAT_A = "11111111-1111-4111-8111-111111111111";
export const TEST_CHAT_B = "11111111-1111-4111-8111-111111111112";

/**
 * Real PostgreSQL in memory. Runs the repository's migrations and wraps
 * generated Neon batch statements in one PGlite transaction. There are no
 * service credentials, network connections or persistent database files.
 */
export async function createPostgresFixture() {
  const client = new PGlite();
  const database = postgresDrizzle(client, { schema });
  const folder = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(folder)).filter(name => name.endsWith(".sql")).sort()) {
    await client.exec(await readFile(new URL(file, folder), "utf8"));
  }
  await database.insert(schema.sizeClasses).values({
    id: "test", label: "Test", rank: 1, maxDocuments: 10,
    maxPagesPerDocument: 10, maxTotalPages: 100, maxFileBytes: 1000,
  });
  await database.insert(schema.plans).values({
    id: "test", label: "Test", maxSizeClassId: "test", maxCollections: 10,
    maxQuestionsPerDay: 100, modelId: "test/model",
  });
  const db = Object.assign(database, {
    batch: async (statements: QueryBuilder[]) => client.transaction(async transaction => {
      const results = [];
      for (const statement of statements) {
        // Rebind the prepared query to the transaction's client, retaining
        // Drizzle's RETURNING/date mapping just as Neon batch does.
        const prepared = statement._prepare() as { client: unknown; execute(): Promise<unknown> };
        prepared.client = transaction;
        results.push(await prepared.execute());
      }
      return results;
    }),
  });
  const reset = async () => {
    await client.exec("TRUNCATE users CASCADE");
    await db.insert(schema.users).values([
      { clerkUserId: "tenant-a", planId: "test" },
      { clerkUserId: "tenant-b", planId: "test" },
    ]);
    await db.insert(schema.chats).values([
      { id: TEST_CHAT_A, userId: "tenant-a", title: "Neuer Chat" },
      { id: TEST_CHAT_B, userId: "tenant-b", title: "Privater Chat" },
    ]);
  };
  await reset();
  return { client, db, reset, close: () => client.close() };
}
