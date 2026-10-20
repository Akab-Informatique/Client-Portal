CREATE TABLE "stripe_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"url" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_checkouts" ADD CONSTRAINT "stripe_checkouts_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_checkouts" ADD CONSTRAINT "stripe_checkouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkouts_session_idx" ON "stripe_checkouts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "stripe_checkouts_invoice_idx" ON "stripe_checkouts" USING btree ("invoice_id");