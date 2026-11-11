CREATE TABLE "invoice_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"credit_id" uuid,
	"kind" text NOT NULL,
	"qb_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payment_id" uuid,
	"quickbooks_apply_id" text,
	"quickbooks_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qb_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"qb_id" text NOT NULL,
	"ref" text,
	"txn_date" text NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"remaining_cents" bigint DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_credit_applications" ADD CONSTRAINT "invoice_credit_applications_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credit_applications" ADD CONSTRAINT "invoice_credit_applications_credit_id_qb_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."qb_credits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_credit_applications" ADD CONSTRAINT "invoice_credit_applications_payment_id_invoice_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."invoice_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qb_credits" ADD CONSTRAINT "qb_credits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_credit_apps_invoice_idx" ON "invoice_credit_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qb_credits_unique_idx" ON "qb_credits" USING btree ("kind","qb_id");--> statement-breakpoint
CREATE INDEX "qb_credits_client_idx" ON "qb_credits" USING btree ("client_id");