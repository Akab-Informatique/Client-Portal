CREATE TABLE "client_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"autotask_id" text,
	"number" text NOT NULL,
	"issued_on" text NOT NULL,
	"due_on" text,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"paid_on" text,
	"voided" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoices_autotask_idx" ON "client_invoices" USING btree ("autotask_id");--> statement-breakpoint
CREATE INDEX "client_invoices_client_idx" ON "client_invoices" USING btree ("client_id","issued_on");