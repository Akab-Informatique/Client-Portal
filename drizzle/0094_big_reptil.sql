CREATE TABLE "itcloud_clients" (
	"itcloud_id" integer PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itcloud_services" (
	"service_id" integer PRIMARY KEY NOT NULL,
	"itcloud_client_id" integer NOT NULL,
	"client_name" text DEFAULT '' NOT NULL,
	"product_group" text DEFAULT '' NOT NULL,
	"product" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"billing_cycle" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"registration_date" text,
	"next_invoice_date" text,
	"state" text DEFAULT 'inactive' NOT NULL,
	"contract_name" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_services" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_services" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "contract_services" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "vendor_sku" text;--> statement-breakpoint
ALTER TABLE "itcloud_clients" ADD CONSTRAINT "itcloud_clients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "itcloud_services_client_idx" ON "itcloud_services" USING btree ("itcloud_client_id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_services_external_idx" ON "contract_services" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_sku_idx" ON "services" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "services_vendor_sku_idx" ON "services" USING btree ("vendor_id","vendor_sku");