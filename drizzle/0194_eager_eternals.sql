ALTER TABLE "proj_projects" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "delivered_by" uuid;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "overrun_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_delivered_by_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;