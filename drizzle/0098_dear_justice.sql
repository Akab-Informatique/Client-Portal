CREATE TABLE "contract_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"actor_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "billing_period" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "ended_on" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_events_contract_idx" ON "contract_events" USING btree ("contract_id","created_at");