ALTER TABLE "client_contracts" ADD COLUMN "bank_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "bank_rollover" text DEFAULT 'lose' NOT NULL;