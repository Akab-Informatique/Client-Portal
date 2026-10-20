CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow" text NOT NULL,
	"ticket_id" bigint NOT NULL,
	"ticket_number" text DEFAULT '' NOT NULL,
	"ticket_title" text DEFAULT '' NOT NULL,
	"to_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_ticket_idx" ON "workflow_runs" USING btree ("workflow","ticket_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_created_idx" ON "workflow_runs" USING btree ("workflow","created_at");