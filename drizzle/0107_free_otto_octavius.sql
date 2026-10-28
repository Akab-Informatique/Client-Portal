ALTER TABLE "client_contracts" ADD COLUMN "bundle_price_cents" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "bundle_quantity" integer DEFAULT 1 NOT NULL;