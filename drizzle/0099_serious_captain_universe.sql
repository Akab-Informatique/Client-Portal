CREATE TABLE "cleanup_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"user_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"previous" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "billed_through" text;--> statement-breakpoint
ALTER TABLE "cleanup_log" ADD CONSTRAINT "cleanup_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cleanup_log_run_idx" ON "cleanup_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cleanup_log_kind_idx" ON "cleanup_log" USING btree ("kind","created_at");