CREATE TABLE "watch_state" (
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"days" integer,
	CONSTRAINT "watch_state_kind_item_id_pk" PRIMARY KEY("kind","item_id")
);
--> statement-breakpoint
UPDATE "ticket_meta" SET "start_date" = NULL, "start_time" = NULL, "start_locked" = false, "milestone_date" = NULL, "milestone_time" = NULL;
--> statement-breakpoint
UPDATE "pipeline_tasks" SET "start_date" = NULL, "start_time" = NULL, "checkpoint_date" = NULL, "checkpoint_time" = NULL, "due_time" = NULL;
--> statement-breakpoint
UPDATE "proj_projects" SET "start_date" = NULL;
