CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"input_per_million" double precision NOT NULL,
	"output_per_million" double precision NOT NULL,
	"cache_read_per_million" double precision NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"provider" text PRIMARY KEY NOT NULL,
	"encrypted" text NOT NULL,
	"masked" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
