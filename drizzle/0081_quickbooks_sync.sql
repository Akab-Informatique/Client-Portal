ALTER TABLE "clients" ADD COLUMN "qb_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "qb_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "qb_synced_at" timestamp with time zone;