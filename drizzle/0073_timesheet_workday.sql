ALTER TABLE "timesheet_entries" ADD COLUMN "start_time" text;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "end_time" text;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "lunch_minutes" integer;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "billable_x100" integer;--> statement-breakpoint
ALTER TABLE "timesheet_types" ADD COLUMN "billable" boolean DEFAULT false NOT NULL;