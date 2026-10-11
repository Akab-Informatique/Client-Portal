CREATE TABLE "ticket_meta" (
	"ticket_id" bigint PRIMARY KEY NOT NULL,
	"start_date" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD CONSTRAINT "ticket_meta_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- New Tickets module: give its rights to the built-in Technician role (once)
UPDATE "roles"
SET "permissions" = "permissions" || '["tickets.view","tickets.edit"]'::jsonb
WHERE "slug" = 'technician' AND NOT ("permissions" ? 'tickets.view');
