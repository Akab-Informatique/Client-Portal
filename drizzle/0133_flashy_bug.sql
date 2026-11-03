CREATE TABLE "contract_autopay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"email" text,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_name" text,
	"accepted_at" timestamp with time zone,
	"accepted_ip" text,
	"accepted_text" text,
	"stripe_customer_id" text,
	"stripe_payment_method_id" text,
	"setup_session_id" text,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"card_funding" text,
	"live" boolean DEFAULT false NOT NULL,
	"last_charge_at" timestamp with time zone,
	"last_error" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "autopay_id" uuid;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "card_charge_status" text;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "card_charge_error" text;--> statement-breakpoint
ALTER TABLE "contract_autopay" ADD CONSTRAINT "contract_autopay_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_autopay" ADD CONSTRAINT "contract_autopay_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_autopay" ADD CONSTRAINT "contract_autopay_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_autopay_contract_idx" ON "contract_autopay" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_autopay_client_idx" ON "contract_autopay" USING btree ("client_id");