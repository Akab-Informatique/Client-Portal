CREATE TABLE "expense_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "report_id" uuid;--> statement-breakpoint
-- every existing expense becomes a report of its own (same id); open when not sent yet or refused
INSERT INTO "expense_reports" ("id", "user_id", "title", "submitted_at", "created_at", "updated_at") SELECT "id", "user_id", left("description", 120), CASE WHEN "status" IN ('draft', 'rejected') THEN NULL ELSE coalesce("submitted_at", "created_at") END, "created_at", "updated_at" FROM "expenses";--> statement-breakpoint
UPDATE "expenses" SET "report_id" = "id";--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_reports_user_idx" ON "expense_reports" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_report_id_expense_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."expense_reports"("id") ON DELETE cascade ON UPDATE no action;