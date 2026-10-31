ALTER TABLE "client_contracts" ADD COLUMN "rebate_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_services" ADD COLUMN "rebate_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_charges" ADD COLUMN "rebate_bps" integer DEFAULT 0 NOT NULL;