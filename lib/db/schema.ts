import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { CollectionKind, CollectionSchema } from "../collection-kinds";
import type { Anbieter, KeyAnbieter } from "../models";
import type { VerarbeitungOverride } from "../presets";
import type { ToolStep } from "../tools-types";

/**
 * Datenmodell der mandantenfaehigen Anwendung.
 *
 * Zwei Begriffe, die sich leicht verwechseln lassen:
 *
 *   Groessenklasse (size_classes) — S/M/L/XL. Legt fest, wie viel in EINE
 *     Collection hineinpasst: Dokumente, Seiten je Dokument, Gesamtseiten.
 *   Plan (plans) — wird einem Nutzer zugewiesen. Legt fest, bis zu welcher
 *     Groessenklasse er Collections anlegen darf, wie viele, und wie viele
 *     Fragen er pro Tag stellen kann.
 *
 * Beides ist im Admin-Bereich editierbar; die Werte stehen deshalb in
 * Tabellen und nicht im Code.
 */

export const sizeClasses = pgTable("size_classes", {
  /** 'S' | 'M' | 'L' | 'XL' — sprechend, damit Debugging nicht in IDs endet. */
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /**
   * Rangfolge fuer den Vergleich "darf der Nutzer diese Klasse anlegen?".
   * Ueber einen Zahlenrang statt ueber die Reihenfolge von Buchstaben,
   * damit der Admin spaeter Klassen einfuegen kann.
   */
  rank: integer("rank").notNull(),
  maxDocuments: integer("max_documents").notNull(),
  maxPagesPerDocument: integer("max_pages_per_document").notNull(),
  maxTotalPages: integer("max_total_pages").notNull(),
  maxFileBytes: integer("max_file_bytes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /** Hoechste Groessenklasse, die dieser Plan freischaltet. */
  maxSizeClassId: text("max_size_class_id")
    .notNull()
    .references(() => sizeClasses.id),
  maxCollections: integer("max_collections").notNull(),
  /**
   * Tageskontingent an Fragen. Ohne diese Grenze ist die Anwendung
   * wirtschaftlich nicht steuerbar — eine einzige Schleife im Browser
   * koennte sonst das Monatsbudget des Modellanbieters aufbrauchen.
   */
  maxQuestionsPerDay: integer("max_questions_per_day").notNull(),
  /**
   * Modellkennung aus dem Katalog (models.id), z. B. "google/gemini-2.5-flash-lite".
   * Bewusst ohne Fremdschluessel: Ein Modell darf aus dem Katalog verschwinden,
   * ohne dass der Plan mit ihm faellt — der Chat faellt dann auf das
   * Standardmodell zurueck. Dass ein Plan nur ein vorhandenes, aktives Modell
   * erhaelt, prueft speicherePlan in lib/admin.ts.
   */
  modelId: text("model_id").notNull(),
  /** Genau ein Plan traegt true — den bekommen neue Registrierungen. */
  isDefault: boolean("is_default").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  /** Die Clerk-ID ist der Primaerschluessel: keine zweite Identitaet, kein Abgleich. */
  clerkUserId: text("clerk_user_id").primaryKey(),
  email: text("email"),
  name: text("name"),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  isAdmin: boolean("is_admin").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Verarbeitungspreset einer Collection. Siehe lib/presets.ts. */
export type PresetId = "fliesstext" | "tabellen" | "regelwerke";

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.clerkUserId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Die Beschreibung ist nicht Zierde: Sie steht im Katalog, den das Modell
     * beim Tool-Aufruf sieht, und entscheidet dort ueber die Auswahl der
     * Collection. Fehlt sie, wird sie nach der ersten Ingestion vorgeschlagen.
     */
    description: text("description").notNull().default(""),
    descriptionSource: text("description_source").notNull().default("user"),
    preset: text("preset").$type<PresetId>().notNull(),
    /**
     * Sammlungstyp (siehe lib/collection-kinds.ts): vector = Dokumente in der
     * Vektor-Datenbank, sql = CSV-Tabellen in SQLite, graph = Cypher in
     * FalkorDB. Das Preset gilt nur fuer den Typ vector.
     */
    kind: text("kind").$type<CollectionKind>().notNull().default("vector"),
    /**
     * Abweichungen vom Preset aus dem Expertenmodus (siehe lib/presets.ts):
     * Abschnittsgroesse, Ueberlappung, Treffer je Suche, Mindest-Aehnlichkeit.
     * Nur fuer den Typ vector. null heisst: die Werte des Presets gelten —
     * auch dann noch, wenn das Preset spaeter nachjustiert wird.
     */
    processing: jsonb("processing").$type<VerarbeitungOverride>(),
    /**
     * Struktur der Daten fuer sql- und graph-Sammlungen (Tabellen und
     * Spalten bzw. Labels und Kantentypen). Das Modell braucht sie, um SQL
     * oder Cypher zu formulieren. Bei vector-Sammlungen null.
     */
    schema: jsonb("schema").$type<CollectionSchema>(),
    sizeClassId: text("size_class_id")
      .notNull()
      .references(() => sizeClasses.id),
    documentCount: integer("document_count").default(0).notNull(),
    pageCount: integer("page_count").default(0).notNull(),
    chunkCount: integer("chunk_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("collections_user_idx").on(table.userId)],
);

/** Lebenslauf eines Dokuments durch die Ingestion. */
export type DocumentStatus = "wartet" | "laeuft" | "fertig" | "fehler";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /**
     * Denormalisiert. Die Zugehoerigkeitspruefung ist der haeufigste Zugriff
     * ueberhaupt und soll ohne Join auskommen.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.clerkUserId, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    /** Mandantenpraefigiert: files/<userId>/<collectionId>/<docId>/<datei>. */
    blobPath: text("blob_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    pageCount: integer("page_count").default(0).notNull(),
    chunkCount: integer("chunk_count").default(0).notNull(),
    status: text("status").$type<DocumentStatus>().notNull().default("wartet"),
    error: text("error"),
    workflowRunId: text("workflow_run_id"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("documents_collection_idx").on(table.collectionId),
    index("documents_user_idx").on(table.userId),
  ],
);

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.clerkUserId, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Nach einer Umbenennung darf der Auto-Titel nicht mehr eingreifen. */
    titleManual: boolean("title_manual").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("chats_user_updated_idx").on(table.userId, table.updatedAt)],
);

/** Fundstelle unter einer Antwort. Liegt als JSON an der Nachricht. */
export type StoredSource = {
  n: number;
  filename: string;
  location: string | null;
  score: number;
  snippet: string;
  collectionName: string;
};

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources").$type<StoredSource[]>(),
    /** Werkzeugaufrufe (Suche, SQL, Cypher), die zu dieser Antwort gefuehrt haben. */
    steps: jsonb("steps").$type<ToolStep[]>(),
    isError: boolean("is_error").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("messages_chat_idx").on(table.chatId, table.createdAt)],
);

/**
 * Verbrauchsjournal. Die Kontingentpruefung selbst laeuft ueber Redis-Zaehler
 * (lib/ratelimit.ts) — schnell und ohne Schreiblast auf Postgres. Diese Tabelle
 * ist die nachvollziehbare Abrechnung und Grundlage der Admin-Auswertung.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Kalendertag in UTC — Gruppierschluessel der Auswertung. */
    day: date("day").notNull(),
    kind: text("kind").$type<"frage" | "ingestion">().notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    /** Kosten in Mikro-Dollar; Ganzzahl, damit nichts an Rundung verloren geht. */
    costMicros: integer("cost_micros").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("usage_user_day_idx").on(table.userId, table.day)],
);

/**
 * Webhook-Zustellungen von Clerk. Svix wiederholt bei Fehlern, deshalb wird
 * die svix-id festgehalten und eine zweite Zustellung verworfen.
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * API-Keys der Modellanbieter, vom Admin hinterlegt.
 *
 * Der Klartext liegt nie in der Datenbank: `encrypted` ist ein AES-256-GCM-
 * Chiffrat (lib/crypto.ts), dessen Schluessel aus PROVIDER_KEY_SECRET
 * abgeleitet wird. `masked` ist das, was die Oberflaeche zeigen darf
 * ("sk-ant-…7f3a") — vorberechnet, damit die Statusanzeige nicht entschluesseln muss.
 */
export const providerKeys = pgTable("provider_keys", {
  provider: text("provider").$type<KeyAnbieter>().primaryKey(),
  encrypted: text("encrypted").notNull(),
  masked: text("masked").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Modellkatalog. Ersetzt die frueher fest kodierte Liste in lib/models.ts.
 *
 * `id` hat die Form "<praefix>/<native-id>", z. B. "anthropic/claude-sonnet-4-5"
 * oder "google/gemini-2.5-flash". `provider` sagt, WOHIN der Aufruf geht:
 * "anthropic" oder "openai" direkt an den Anbieter (mit hinterlegtem Key),
 * "gateway" ueber das Vercel AI Gateway. Die Preise sind die Grundlage der
 * Kostenrechnung in usage_events — als double precision, weil ein float4 aus
 * 0,01 $ ein 0,00999999… macht und damit die Rundung auf Mikro-Dollar kippt.
 */
export const models = pgTable("models", {
  id: text("id").primaryKey(),
  provider: text("provider").$type<Anbieter>().notNull(),
  label: text("label").notNull(),
  /** US-Dollar je 1 Mio. Token. */
  inputPerMillion: doublePrecision("input_per_million").notNull(),
  outputPerMillion: doublePrecision("output_per_million").notNull(),
  cacheReadPerMillion: doublePrecision("cache_read_per_million").notNull(),
  /** Nur aktive Modelle stehen im Auswahlfeld der Plaene. */
  enabled: boolean("enabled").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Beziehungen ------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  plan: one(plans, { fields: [users.planId], references: [plans.id] }),
  collections: many(collections),
  chats: many(chats),
}));

export const plansRelations = relations(plans, ({ one }) => ({
  maxSizeClass: one(sizeClasses, {
    fields: [plans.maxSizeClassId],
    references: [sizeClasses.id],
  }),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  user: one(users, { fields: [collections.userId], references: [users.clerkUserId] }),
  sizeClass: one(sizeClasses, {
    fields: [collections.sizeClassId],
    references: [sizeClasses.id],
  }),
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  collection: one(collections, {
    fields: [documents.collectionId],
    references: [collections.id],
  }),
}));

export const chatsRelations = relations(chats, ({ one, many }) => ({
  user: one(users, { fields: [chats.userId], references: [users.clerkUserId] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, { fields: [messages.chatId], references: [chats.id] }),
}));

export type SizeClass = typeof sizeClasses.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type AppUser = typeof users.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type DocumentRecord = typeof documents.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
