CREATE TABLE "pipeline_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"shared" boolean DEFAULT true NOT NULL,
	"owner_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD COLUMN "list_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_lists" ADD CONSTRAINT "pipeline_lists_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_tasks" ADD CONSTRAINT "pipeline_tasks_list_id_pipeline_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."pipeline_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Every existing task goes on a list: team tasks on one shared team list, the others on their maker's personal list
INSERT INTO "pipeline_lists" ("name", "shared", "position") VALUES ('Liste d''équipe', true, 0);--> statement-breakpoint
INSERT INTO "pipeline_lists" ("name", "shared", "owner_id", "position")
  SELECT 'Ma liste', false, u.created_by, 1 FROM (SELECT DISTINCT created_by FROM "pipeline_tasks" WHERE visibility <> 'team' AND created_by IS NOT NULL) u;--> statement-breakpoint
UPDATE "pipeline_tasks" t SET "list_id" = l.id FROM "pipeline_lists" l WHERE t.visibility <> 'team' AND t.created_by IS NOT NULL AND l.shared = false AND l.owner_id = t.created_by;--> statement-breakpoint
UPDATE "pipeline_tasks" SET "list_id" = (SELECT id FROM "pipeline_lists" WHERE shared = true ORDER BY position LIMIT 1) WHERE "list_id" IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_tasks_list_idx" ON "pipeline_tasks" ("list_id");
