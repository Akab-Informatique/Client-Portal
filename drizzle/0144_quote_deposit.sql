ALTER TABLE "quotes" ADD COLUMN "deposit_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "deposit_percent_x100" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deposit_invoice_id_client_invoices_id_fk" FOREIGN KEY ("deposit_invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE set null ON UPDATE no action;