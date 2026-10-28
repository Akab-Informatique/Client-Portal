ALTER TABLE "quote_lines" ADD COLUMN "details" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "recurrence" text DEFAULT 'once' NOT NULL;