CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"quantity_x100" integer DEFAULT 100 NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"qb_item_id" text,
	"qb_tax_code_id" text
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"client_id" uuid NOT NULL,
	"invoice_id" uuid,
	"issued_on" text NOT NULL,
	"reason" text,
	"subtotal_cents" bigint NOT NULL,
	"gst_cents" bigint DEFAULT 0 NOT NULL,
	"qst_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"applied_cents" bigint DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"quickbooks_id" text,
	"quickbooks_apply_id" text,
	"quickbooks_error" text,
	"quickbooks_synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_note_idx" ON "credit_note_lines" USING btree ("credit_note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_number_unique" ON "credit_notes" USING btree ("number");--> statement-breakpoint
CREATE INDEX "credit_notes_client_idx" ON "credit_notes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");