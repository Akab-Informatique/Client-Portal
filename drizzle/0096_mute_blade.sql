CREATE TABLE "itcloud_service_contracts" (
	"service_id" integer PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "itcloud_service_contracts" ADD CONSTRAINT "itcloud_service_contracts_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE cascade ON UPDATE no action;