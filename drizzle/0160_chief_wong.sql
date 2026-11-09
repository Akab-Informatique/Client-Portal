ALTER TABLE "ticket_day_adds" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD CONSTRAINT "ticket_day_adds_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD CONSTRAINT "ticket_day_adds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_day_adds_milestone_unique" ON "ticket_day_adds" USING btree ("milestone_id","user_id","for_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_day_adds_project_unique" ON "ticket_day_adds" USING btree ("project_id","user_id","for_date");