ALTER TABLE "expense_reports" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;