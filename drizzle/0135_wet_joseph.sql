ALTER TABLE "invoice_payments" ADD COLUMN "quickbooks_id" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "quickbooks_error" text;--> statement-breakpoint
ALTER TABLE "stripe_checkouts" ADD COLUMN "fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_checkouts" ADD COLUMN "fee_tax_cents" integer DEFAULT 0 NOT NULL;