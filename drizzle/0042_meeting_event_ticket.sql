ALTER TABLE "meeting_events" ADD COLUMN "ticket_id" bigint;--> statement-breakpoint
ALTER TABLE "meeting_events" ADD COLUMN "ticket_number" text;--> statement-breakpoint
ALTER TABLE "meeting_events" ADD COLUMN "ticket_title" text;