CREATE TABLE "deleted_tickets" (
	"ticket_id" bigint PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_reports" ADD COLUMN "autotask_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "autotask_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "autotask_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deleted_tickets" ADD CONSTRAINT "deleted_tickets_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;