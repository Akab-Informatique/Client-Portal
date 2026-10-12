CREATE TABLE "autotask_tickets" (
	"id" bigint PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"last_activity" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "autotask_tickets_activity_idx" ON "autotask_tickets" USING btree ("last_activity");