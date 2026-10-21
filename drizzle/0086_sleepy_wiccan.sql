ALTER TABLE "quotes" ADD COLUMN "project_ticket_id" bigint;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "project_ticket_number" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "meeting_point_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "project_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_meeting_point_id_meeting_points_id_fk" FOREIGN KEY ("meeting_point_id") REFERENCES "public"."meeting_points"("id") ON DELETE set null ON UPDATE no action;