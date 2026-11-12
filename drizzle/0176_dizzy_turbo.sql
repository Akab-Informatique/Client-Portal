ALTER TABLE "ticket_notes" ADD COLUMN "worked_minutes" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "delegate_user_id" uuid;