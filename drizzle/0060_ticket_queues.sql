CREATE TABLE "ticket_queues" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"alerts" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "queue" text;
--> statement-breakpoint
-- the portal's own queues, to start: Support (default), Alertes (monitoring), Projets
INSERT INTO "ticket_queues" ("key", "name", "alerts", "is_default", "position") VALUES ('support', 'Support', false, true, 0), ('alerts', 'Alertes', true, false, 1), ('projects', 'Projets', false, false, 2);
