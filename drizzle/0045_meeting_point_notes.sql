CREATE TABLE "meeting_point_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"point_id" uuid NOT NULL,
	"text" text NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_points" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_points" ADD COLUMN "snooze_until" text;--> statement-breakpoint
ALTER TABLE "meeting_point_notes" ADD CONSTRAINT "meeting_point_notes_point_id_meeting_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."meeting_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_point_notes" ADD CONSTRAINT "meeting_point_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_point_notes_point_idx" ON "meeting_point_notes" USING btree ("point_id");