ALTER TABLE "billing_items" ADD COLUMN "qb_item_id" text;--> statement-breakpoint
ALTER TABLE "billing_items" ADD COLUMN "qb_tax_code_id" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "qb_item_id" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "qb_tax_code_id" text;