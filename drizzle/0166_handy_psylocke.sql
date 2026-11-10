CREATE TABLE "pipeline_task_timers" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"base_seconds" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	CONSTRAINT "pipeline_task_timers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "pipeline_task_timers" ADD CONSTRAINT "pipeline_task_timers_task_id_pipeline_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."pipeline_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_task_timers" ADD CONSTRAINT "pipeline_task_timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;