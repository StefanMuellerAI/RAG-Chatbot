import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  /** Modellkennung fuer das AI Gateway, z. B. "anthropic/claude-haiku-4.5". */
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
