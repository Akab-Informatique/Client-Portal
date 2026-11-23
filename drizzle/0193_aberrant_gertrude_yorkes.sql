CREATE TABLE "opp_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opp_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opp_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opp_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" text DEFAULT 'note' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"client_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"description" text NOT NULL,
	"source" text DEFAULT 'other' NOT NULL,
	"handling" text DEFAULT 'quote_only' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"owner_id" uuid,
	"ticket_id" bigint,
	"ticket_number" text,
	"ticket_title" text,
	"lost_reason" text,
	"close_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "opp_links" ADD CONSTRAINT "opp_links_opp_id_opps_id_fk" FOREIGN KEY ("opp_id") REFERENCES "public"."opps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opp_links" ADD CONSTRAINT "opp_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opp_notes" ADD CONSTRAINT "opp_notes_opp_id_opps_id_fk" FOREIGN KEY ("opp_id") REFERENCES "public"."opps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opp_notes" ADD CONSTRAINT "opp_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opps" ADD CONSTRAINT "opps_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opps" ADD CONSTRAINT "opps_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opps" ADD CONSTRAINT "opps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opps" ADD CONSTRAINT "opps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opp_links_unique" ON "opp_links" USING btree ("opp_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "opp_notes_opp_idx" ON "opp_notes" USING btree ("opp_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opps_number_unique" ON "opps" USING btree ("number");--> statement-breakpoint
CREATE INDEX "opps_status_idx" ON "opps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opps_client_idx" ON "opps" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "opps_ticket_idx" ON "opps" USING btree ("ticket_id");