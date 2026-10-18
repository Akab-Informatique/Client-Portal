ALTER TABLE "billing_items" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "po_number" text;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;