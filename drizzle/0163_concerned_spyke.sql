CREATE TABLE "project_milestone_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"kind" text DEFAULT 'internal' NOT NULL,
	"emailed_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestone_timers" (
	"milestone_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_milestone_timers_milestone_id_user_id_pk" PRIMARY KEY("milestone_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "timesheet_entry_tasks" (
	"entry_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"status_after" text NOT NULL,
	CONSTRAINT "timesheet_entry_tasks_entry_id_task_id_pk" PRIMARY KEY("entry_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "project_milestone_notes" ADD CONSTRAINT "project_milestone_notes_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestone_notes" ADD CONSTRAINT "project_milestone_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestone_timers" ADD CONSTRAINT "project_milestone_timers_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestone_timers" ADD CONSTRAINT "project_milestone_timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry_tasks" ADD CONSTRAINT "timesheet_entry_tasks_entry_id_timesheet_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."timesheet_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entry_tasks" ADD CONSTRAINT "timesheet_entry_tasks_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_milestone_notes_ms_idx" ON "project_milestone_notes" USING btree ("milestone_id","created_at");