CREATE TABLE "ticket_board_cards" (
	"ticket_id" bigint PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "roles_slug_unique";--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_board_cards" ADD CONSTRAINT "ticket_board_cards_board_id_ticket_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."ticket_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_boards" ADD CONSTRAINT "ticket_boards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_board_cards_board_idx" ON "ticket_board_cards" USING btree ("board_id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_client_idx" ON "roles" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_slug_unique" ON "roles" USING btree (coalesce("client_id"::text, ''),"slug");