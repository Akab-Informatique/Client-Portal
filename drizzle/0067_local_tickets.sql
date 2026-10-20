CREATE TABLE "ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"data" text,
	"internal" boolean DEFAULT false NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity_x100" integer DEFAULT 100 NOT NULL,
	"unit_price_cents" bigint,
	"unit_cost_cents" bigint,
	"billable" boolean DEFAULT true NOT NULL,
	"type" text,
	"status" text,
	"material_code" text,
	"product_id" text,
	"contract_id" text,
	"date" text,
	"author" text,
	"billed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"external_id" text,
	"author" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"text" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"external_id" text,
	"user_id" uuid,
	"author" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"offset_minutes" integer DEFAULT 0 NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"internal_text" text DEFAULT '' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"work_type" text,
	"contract_id" text,
	"billed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigint PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"company_id" bigint NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"contact_id" text,
	"contact_name" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"queue" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'portal' NOT NULL,
	"assignee_id" text,
	"assignee_name" text,
	"secondary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"asset_id" text,
	"contract_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_charges" ADD CONSTRAINT "ticket_charges_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_attachments_ticket_idx" ON "ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_attachments_external_idx" ON "ticket_attachments" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "ticket_charges_ticket_idx" ON "ticket_charges" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_charges_external_idx" ON "ticket_charges" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "ticket_notes_ticket_idx" ON "ticket_notes" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_notes_external_idx" ON "ticket_notes" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "ticket_time_ticket_idx" ON "ticket_time_entries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_time_started_idx" ON "ticket_time_entries" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_time_external_idx" ON "ticket_time_entries" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_idx" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_company_idx" ON "tickets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tickets_completed_idx" ON "tickets" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "tickets_created_idx" ON "tickets" USING btree ("created_at");