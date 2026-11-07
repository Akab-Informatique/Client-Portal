CREATE TABLE "pipeline_task_assignees" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_task_assignees_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "pipeline_task_assignees" ADD CONSTRAINT "pipeline_task_assignees_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_assignees" ADD CONSTRAINT "pipeline_task_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_task_assignees_user_idx" ON "pipeline_task_assignees" USING btree ("user_id");