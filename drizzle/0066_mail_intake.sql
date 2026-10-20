CREATE TABLE "mail_intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"mailbox" text NOT NULL,
	"from_address" text,
	"from_name" text,
	"subject" text,
	"body" text,
	"received_at" timestamp with time zone,
	"status" text DEFAULT 'processing' NOT NULL,
	"ticket_id" bigint,
	"ticket_number" text,
	"company_id" integer,
	"contact_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_intake_message_idx" ON "mail_intake" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_intake_status_idx" ON "mail_intake" USING btree ("status");