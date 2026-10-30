CREATE TABLE "recurring_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"amount_cents" bigint,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"day_of_month" integer,
	"weekday" integer,
	"month" integer,
	"account" text,
	"method" text,
	"notes" text,
	"in_quickbooks" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recurring_payments_name_idx" ON "recurring_payments" USING btree ("name");