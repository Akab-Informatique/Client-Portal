CREATE TABLE "ticket_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"ticket_number" text NOT NULL,
	"ticket_title" text NOT NULL,
	"state" text NOT NULL,
	"accumulated_ms" bigint DEFAULT 0 NOT NULL,
	"running_since" timestamp with time zone,
	"last_beat_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_timers" ADD CONSTRAINT "ticket_timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_timers_user_ticket_unique" ON "ticket_timers" USING btree ("user_id","ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_timers_state_idx" ON "ticket_timers" USING btree ("state");