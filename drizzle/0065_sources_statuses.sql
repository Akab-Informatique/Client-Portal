CREATE TABLE "ticket_sources" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_statuses" (
	"value" text PRIMARY KEY NOT NULL,
	"label" text,
	"kind" text,
	"position" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "source" text;
--> statement-breakpoint
INSERT INTO "ticket_sources" ("key", "name", "position") VALUES
	('phone', 'Téléphone', 0),
	('sms', 'Texto', 1),
	('email', 'Courriel', 2),
	('in-person', 'En personne', 3);
