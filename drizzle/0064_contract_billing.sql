ALTER TABLE "client_contracts" ADD COLUMN "billing_mode" text DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "hourly_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "monthly_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "ticket_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "support_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "contract_id" uuid;