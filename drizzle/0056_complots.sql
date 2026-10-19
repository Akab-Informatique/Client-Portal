CREATE TABLE "complots_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"status" text DEFAULT 'lobby' NOT NULL,
	"seats" jsonb NOT NULL,
	"chars" jsonb NOT NULL,
	"state" jsonb,
	"winner_id" uuid,
	"rev" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "complots_games" ADD CONSTRAINT "complots_games_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complots_games" ADD CONSTRAINT "complots_games_winner_id_users_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complots_games_status_idx" ON "complots_games" USING btree ("status","updated_at");