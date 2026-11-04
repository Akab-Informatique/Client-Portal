CREATE TABLE "ticket_day_adds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"for_date" text NOT NULL,
	"due_time" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD CONSTRAINT "ticket_day_adds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_day_adds_unique" ON "ticket_day_adds" USING btree ("ticket_id","user_id","for_date");--> statement-breakpoint
CREATE INDEX "ticket_day_adds_user_idx" ON "ticket_day_adds" USING btree ("user_id","for_date");