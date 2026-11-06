ALTER TABLE "projects" ADD COLUMN "quote_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "invoiced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "project_id" uuid;