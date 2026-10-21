CREATE TABLE "pipeline_checklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_day_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity_minutes" integer DEFAULT 0 NOT NULL,
	"planned_minutes" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'rules' NOT NULL,
	"sms_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_task_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid,
	"author" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_id" uuid,
	"created_by" uuid,
	"parent_id" uuid,
	"blocked_by_id" uuid,
	"due_date" text,
	"estimate_minutes" integer,
	"ticket_id" bigint,
	"ticket_number" text,
	"ticket_title" text,
	"position" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_checklist" ADD CONSTRAINT "pipeline_checklist_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_day_plans" ADD CONSTRAINT "pipeline_day_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_notes" ADD CONSTRAINT "pipeline_task_notes_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_notes" ADD CONSTRAINT "pipeline_task_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_parent_id_pipeline_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_blocked_by_id_pipeline_tasks_id_fk" FOREIGN KEY ("blocked_by_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_checklist_task_idx" ON "pipeline_checklist" USING btree ("task_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_day_plans_user_date_unique" ON "pipeline_day_plans" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "pipeline_task_notes_task_idx" ON "pipeline_task_notes" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_tasks_assignee_idx" ON "pipeline_tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_tasks_parent_idx" ON "pipeline_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pipeline_tasks_due_idx" ON "pipeline_tasks" USING btree ("due_date");