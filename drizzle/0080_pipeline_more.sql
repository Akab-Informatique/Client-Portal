CREATE TABLE "pipeline_task_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"data" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_task_viewers" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "pipeline_task_viewers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "pipeline_day_plans" ADD COLUMN "calendar" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_day_plans" ADD COLUMN "calendar_events" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "due_time" text;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "start_date" text;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "start_time" text;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "visibility" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_task_files" ADD CONSTRAINT "pipeline_task_files_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_files" ADD CONSTRAINT "pipeline_task_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_viewers" ADD CONSTRAINT "pipeline_task_viewers_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_viewers" ADD CONSTRAINT "pipeline_task_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_task_files_task_idx" ON "pipeline_task_files" USING btree ("task_id");