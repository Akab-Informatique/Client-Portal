CREATE TABLE "project_task_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_task_timers" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_timers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "status" text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "estimate_minutes" integer;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "billing_mode" text DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "hourly_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "fixed_price_cents" integer;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "project_task_notes" ADD CONSTRAINT "project_task_notes_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_notes" ADD CONSTRAINT "project_task_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_timers" ADD CONSTRAINT "project_task_timers_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_timers" ADD CONSTRAINT "project_task_timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_task_notes_task_idx" ON "project_task_notes" USING btree ("task_id","created_at");