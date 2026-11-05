CREATE TABLE "project_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"remind_on" text NOT NULL,
	"text" text NOT NULL,
	"done_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_milestones" ADD COLUMN "start_date" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "checkpoint_every_days" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "checkpoint_date" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_followup_on" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "checkpoint_notified_for" text;--> statement-breakpoint
ALTER TABLE "project_reminders" ADD CONSTRAINT "project_reminders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reminders" ADD CONSTRAINT "project_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reminders" ADD CONSTRAINT "project_reminders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_reminders_project_idx" ON "project_reminders" USING btree ("project_id","remind_on");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;