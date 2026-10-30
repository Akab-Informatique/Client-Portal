CREATE TABLE "hr_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account" text NOT NULL,
	"cents" bigint,
	"hours_x100" integer,
	"kind" text NOT NULL,
	"entry_id" uuid,
	"week_start" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hourly_wage_cents" integer,
	"overtime_after_x100" integer DEFAULT 4000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD COLUMN "billed_minutes" integer;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "non_billable_x100" integer;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "bank_x100" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "ticket_time_id" uuid;--> statement-breakpoint
ALTER TABLE "hr_ledger" ADD CONSTRAINT "hr_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_ledger" ADD CONSTRAINT "hr_ledger_entry_id_timesheet_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."timesheet_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_ledger" ADD CONSTRAINT "hr_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_profiles" ADD CONSTRAINT "hr_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_ledger_user_idx" ON "hr_ledger" USING btree ("user_id","account");--> statement-breakpoint
CREATE INDEX "hr_ledger_entry_idx" ON "hr_ledger" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_ledger_accrual_idx" ON "hr_ledger" USING btree ("user_id","week_start") WHERE "hr_ledger"."kind" = 'accrual';--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timesheet_entries_client_idx" ON "timesheet_entries" USING btree ("client_id");--> statement-breakpoint
UPDATE "timesheet_entries" e SET "client_id" = c."id" FROM "tickets" t, "clients" c WHERE e."ticket_id" = t."id" AND c."autotask_id" = t."company_id" AND e."client_id" IS NULL;--> statement-breakpoint
UPDATE "timesheet_entries" e SET "client_id" = p."client_id" FROM "projects" p WHERE e."project_id" = p."id" AND e."client_id" IS NULL;--> statement-breakpoint
UPDATE "timesheet_entries" SET "non_billable_x100" = GREATEST(0, "hours_x100" - COALESCE("billable_x100", "hours_x100")) WHERE "non_billable_x100" IS NULL AND "source" IN ('ticket', 'project');
--> statement-breakpoint
UPDATE "timesheet_types" SET "kind" = 'vacation' WHERE "kind" = 'other' AND "name" = 'Vacances';--> statement-breakpoint
UPDATE "timesheet_types" SET "kind" = 'sick' WHERE "kind" = 'other' AND "name" = 'Maladie';--> statement-breakpoint
UPDATE "timesheet_types" SET "kind" = 'travel' WHERE "kind" = 'other' AND "name" = 'Déplacement';--> statement-breakpoint
UPDATE "timesheet_types" SET "active" = false WHERE "kind" = 'other' AND "name" = 'Administration';
