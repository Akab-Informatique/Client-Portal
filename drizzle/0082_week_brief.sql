CREATE TABLE "meeting_week_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" text NOT NULL,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'rules' NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_week_briefs_week_start_unique" UNIQUE("week_start")
);
--> statement-breakpoint
ALTER TABLE "meeting_week_briefs" ADD CONSTRAINT "meeting_week_briefs_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;