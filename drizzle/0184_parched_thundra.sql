CREATE TABLE "proj_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proj_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "proj_note_tasks" (
	"note_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "proj_note_tasks_note_id_task_id_pk" PRIMARY KEY("note_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "proj_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"internal" boolean DEFAULT true NOT NULL,
	"emailed_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proj_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"client_id" uuid,
	"lead_id" uuid,
	"contact_id" uuid,
	"status" text DEFAULT 'planning' NOT NULL,
	"start_date" text,
	"due_date" text,
	"sold_hours_x100" integer,
	"description" text DEFAULT '' NOT NULL,
	"sales_notes" text DEFAULT '' NOT NULL,
	"quote_id" uuid,
	"quote_snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "proj_projects_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "proj_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"assignee_id" uuid,
	"due_date" text,
	"position" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proj_time_tasks" (
	"entry_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	CONSTRAINT "proj_time_tasks_entry_id_task_id_pk" PRIMARY KEY("entry_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "proj_timers" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"base_seconds" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	CONSTRAINT "proj_timers_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "proj_id" uuid;--> statement-breakpoint
ALTER TABLE "proj_members" ADD CONSTRAINT "proj_members_project_id_proj_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_members" ADD CONSTRAINT "proj_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_note_tasks" ADD CONSTRAINT "proj_note_tasks_note_id_proj_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."proj_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_note_tasks" ADD CONSTRAINT "proj_note_tasks_task_id_proj_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."proj_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_notes" ADD CONSTRAINT "proj_notes_project_id_proj_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_notes" ADD CONSTRAINT "proj_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_tasks" ADD CONSTRAINT "proj_tasks_project_id_proj_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_tasks" ADD CONSTRAINT "proj_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_tasks" ADD CONSTRAINT "proj_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_time_tasks" ADD CONSTRAINT "proj_time_tasks_entry_id_timesheet_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."timesheet_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_time_tasks" ADD CONSTRAINT "proj_time_tasks_task_id_proj_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."proj_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_timers" ADD CONSTRAINT "proj_timers_project_id_proj_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_timers" ADD CONSTRAINT "proj_timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proj_notes_project_idx" ON "proj_notes" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "proj_projects_status_idx" ON "proj_projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proj_projects_client_idx" ON "proj_projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "proj_projects_lead_idx" ON "proj_projects" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "proj_tasks_project_idx" ON "proj_tasks" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "proj_tasks_assignee_idx" ON "proj_tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "proj_time_tasks_task_idx" ON "proj_time_tasks" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_proj_id_proj_projects_id_fk" FOREIGN KEY ("proj_id") REFERENCES "public"."proj_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timesheet_entries_proj_idx" ON "timesheet_entries" USING btree ("proj_id");