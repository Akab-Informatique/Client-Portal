ALTER TABLE "pipeline_checklist" ADD COLUMN "due_date" text;--> statement-breakpoint
ALTER TABLE "pipeline_checklist" ADD COLUMN "due_time" text;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "continuous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "remind_every_days" integer;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "last_checked_on" text;