CREATE TABLE "mail_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"note" text,
	"source" text DEFAULT 'sent' NOT NULL,
	"times_used" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "email_signature" text;--> statement-breakpoint
ALTER TABLE "mail_contacts" ADD CONSTRAINT "mail_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_contacts_user_address_idx" ON "mail_contacts" USING btree ("user_id","address");