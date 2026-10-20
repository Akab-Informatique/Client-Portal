CREATE TABLE "autotask_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"since" text NOT NULL,
	"content" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_reports" ADD COLUMN "autotask_id" bigint;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "autotask_id" bigint;--> statement-breakpoint
ALTER TABLE "autotask_exports" ADD CONSTRAINT "autotask_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_reports_autotask_idx" ON "expense_reports" USING btree ("autotask_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_autotask_idx" ON "expenses" USING btree ("autotask_id");