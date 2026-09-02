ALTER TABLE "collections" ADD COLUMN "kind" text DEFAULT 'vector' NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "schema" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "steps" jsonb;