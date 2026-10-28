CREATE TABLE "sales_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"client_id" uuid,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"source" text DEFAULT 'other' NOT NULL,
	"kind" text DEFAULT 'recurring' NOT NULL,
	"users" integer,
	"rate_per_user_cents" integer DEFAULT 15000 NOT NULL,
	"one_time_cents" bigint,
	"stage" text DEFAULT 'lead' NOT NULL,
	"probability" integer DEFAULT 10 NOT NULL,
	"opened_on" text NOT NULL,
	"quote_sent_on" text,
	"closed_on" text,
	"next_follow_up" text,
	"lost_reason" text,
	"notes" text,
	"owner_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_opps_stage_idx" ON "sales_opportunities" USING btree ("stage","closed_on");--> statement-breakpoint
CREATE INDEX "sales_opps_owner_idx" ON "sales_opportunities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sales_opps_follow_idx" ON "sales_opportunities" USING btree ("next_follow_up");