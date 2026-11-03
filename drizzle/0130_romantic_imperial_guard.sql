CREATE TABLE "contract_bank_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"day" text NOT NULL,
	"hours_x100" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_items" ADD COLUMN "payer_client_id" uuid;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "shared_with_children" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "billed_to_parent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "support_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "section_client_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "section_name" text;--> statement-breakpoint
ALTER TABLE "contract_bank_adjustments" ADD CONSTRAINT "contract_bank_adjustments_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_bank_adjustments" ADD CONSTRAINT "contract_bank_adjustments_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_bank_adjustments_contract_idx" ON "contract_bank_adjustments" USING btree ("contract_id","day");--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_payer_client_id_clients_id_fk" FOREIGN KEY ("payer_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_support_contract_id_client_contracts_id_fk" FOREIGN KEY ("support_contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_section_client_id_clients_id_fk" FOREIGN KEY ("section_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;