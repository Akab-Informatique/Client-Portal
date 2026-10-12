ALTER TABLE "calendar_blocks" ADD COLUMN "kind" text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD COLUMN "reminder_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD COLUMN "autotask_service_call_id" bigint;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD COLUMN "o365_event_id" text;--> statement-breakpoint
ALTER TABLE "ticket_pins" ADD COLUMN "o365_event_id" text;