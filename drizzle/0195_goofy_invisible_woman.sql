ALTER TABLE "client_contracts" ADD COLUMN "bank_prepaid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "scope_ticket_id" bigint;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "scope_proj_id" uuid;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "quote_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "bank_scope_ticket_id" bigint;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "bank_scope_proj_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "bank_expires_on" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "bank_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD CONSTRAINT "client_contracts_scope_proj_id_proj_projects_id_fk" FOREIGN KEY ("scope_proj_id") REFERENCES "public"."proj_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD CONSTRAINT "client_contracts_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_bank_contract_id_client_contracts_id_fk" FOREIGN KEY ("bank_contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;