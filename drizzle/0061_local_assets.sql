CREATE TABLE "local_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"serial" text,
	"hostname" text,
	"ip" text,
	"os" text,
	"contact_id" text,
	"contact_name" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "local_asset" uuid;--> statement-breakpoint
ALTER TABLE "local_assets" ADD CONSTRAINT "local_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;