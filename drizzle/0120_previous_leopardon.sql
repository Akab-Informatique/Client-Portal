CREATE TABLE "vendor_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quickbooks_id" text NOT NULL,
	"vendor_id" uuid,
	"qb_vendor_id" text,
	"vendor_name" text NOT NULL,
	"doc_number" text,
	"issued_on" text NOT NULL,
	"due_on" text,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"qb_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_quickbooks_idx" ON "vendor_bills" USING btree ("quickbooks_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_due_idx" ON "vendor_bills" USING btree ("due_on");--> statement-breakpoint
CREATE INDEX "vendor_bills_vendor_idx" ON "vendor_bills" USING btree ("vendor_id");