CREATE TABLE "client_classes" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'slate' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "class_key" text;
--> statement-breakpoint
INSERT INTO "client_classes" ("key", "name", "color", "position") VALUES
	('break-fix', 'Break & fix', 'slate', 0),
	('msp', 'MSP', 'blue', 1),
	('bronze', 'Bronze', 'orange', 2),
	('silver', 'Argent', 'zinc', 3),
	('gold', 'Or', 'yellow', 4);
