ALTER TABLE "pipeline_checklist" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "kind" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "last_reset_on" text;--> statement-breakpoint
UPDATE "pipeline_tasks" SET "kind" = 'continuous' WHERE "continuous" = true;