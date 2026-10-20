CREATE TABLE "contract_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'one_time' NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "type_key" text;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "banked_hours_x100" integer;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD COLUMN "fixed_price_cents" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_types_key_idx" ON "contract_types" USING btree ("key");--> statement-breakpoint
CREATE INDEX "services_name_idx" ON "services" USING btree ("name");