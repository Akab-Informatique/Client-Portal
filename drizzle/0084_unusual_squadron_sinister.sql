ALTER TABLE "quotes" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "survey" jsonb DEFAULT '{}'::jsonb NOT NULL;