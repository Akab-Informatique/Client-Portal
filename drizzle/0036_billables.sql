CREATE TABLE "billing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'autotask' NOT NULL,
	"source_id" text,
	"date" text NOT NULL,
	"date_end" text,
	"description" text DEFAULT '' NOT NULL,
	"ticket_number" text,
	"contract_name" text,
	"resource_name" text,
	"quantity_x100" integer DEFAULT 100 NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"invoice_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"billing_item_id" uuid,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity_x100" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"ledger_account_id" uuid,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "source" text DEFAULT 'autotask' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_billing_item_id_billing_items_id_fk" FOREIGN KEY ("billing_item_id") REFERENCES "public"."billing_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_items_source_idx" ON "billing_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "billing_items_status_idx" ON "billing_items" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "billing_items_client_idx" ON "billing_items" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id","position");