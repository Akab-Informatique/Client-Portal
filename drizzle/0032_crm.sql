CREATE TABLE "client_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"autotask_id" text,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"mobile" text,
	"title" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"autotask_id" text,
	"name" text NOT NULL,
	"type" text,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"start_date" text,
	"end_date" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "autotask_id" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "invoice" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD CONSTRAINT "client_contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_contacts_autotask_idx" ON "client_contacts" USING btree ("autotask_id");--> statement-breakpoint
CREATE INDEX "client_contacts_client_idx" ON "client_contacts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_contracts_autotask_idx" ON "client_contracts" USING btree ("autotask_id");--> statement-breakpoint
CREATE INDEX "client_contracts_client_idx" ON "client_contracts" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_parent_id_clients_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_autotask_idx" ON "clients" USING btree ("autotask_id");--> statement-breakpoint
CREATE INDEX "clients_parent_idx" ON "clients" USING btree ("parent_id");