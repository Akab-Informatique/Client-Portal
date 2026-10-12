CREATE TABLE "calendar_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"technician_id" uuid NOT NULL,
	"ticket_id" bigint,
	"ticket_number" text,
	"title" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"ticket_number" text NOT NULL,
	"ticket_title" text NOT NULL,
	"technician_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"horizon" text DEFAULT 'week' NOT NULL,
	"for_date" text NOT NULL,
	"done_at" timestamp with time zone,
	"rank" integer DEFAULT 0 NOT NULL,
	"pinned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_pins" ADD CONSTRAINT "ticket_pins_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_pins" ADD CONSTRAINT "ticket_pins_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_blocks_tech_time_idx" ON "calendar_blocks" USING btree ("technician_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_pins_ticket_tech_unique" ON "ticket_pins" USING btree ("ticket_id","technician_id");--> statement-breakpoint
CREATE INDEX "ticket_pins_tech_idx" ON "ticket_pins" USING btree ("technician_id");