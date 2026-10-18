CREATE TABLE "quickbooks_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quickbooks_id" text NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"type" text NOT NULL,
	"parent_id" text,
	"income_account_id" text,
	"unit_price_cents" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_contacts" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "quickbooks_id" text;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "quickbooks_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "quickbooks_error" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "quickbooks_id" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "quickbooks_item_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_items_qb_idx" ON "quickbooks_items" USING btree ("quickbooks_id");--> statement-breakpoint
CREATE INDEX "quickbooks_items_sku_idx" ON "quickbooks_items" USING btree ("sku");--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_contacts_user_idx" ON "client_contacts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_invoices_quickbooks_idx" ON "client_invoices" USING btree ("quickbooks_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_quickbooks_idx" ON "clients" USING btree ("quickbooks_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_external_idx" ON "invoice_payments" USING btree ("external_id");