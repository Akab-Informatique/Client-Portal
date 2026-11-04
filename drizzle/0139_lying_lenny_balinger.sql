ALTER TABLE "ticket_day_adds" ALTER COLUMN "ticket_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD CONSTRAINT "ticket_day_adds_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_day_adds" ADD CONSTRAINT "ticket_day_adds_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_day_adds_task_unique" ON "ticket_day_adds" USING btree ("task_id","user_id","for_date");