ALTER TABLE "ticket_time_entries" ADD COLUMN "bank_over_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD COLUMN "bank_over_mode" text;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD COLUMN "bank_over_rate_cents" integer;