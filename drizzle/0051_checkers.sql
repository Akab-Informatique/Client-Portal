CREATE TABLE "checkers_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"red_id" uuid NOT NULL,
	"black_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"board" text NOT NULL,
	"turn" text DEFAULT 'r' NOT NULL,
	"must_from" integer,
	"winner" text,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkers_games" ADD CONSTRAINT "checkers_games_red_id_users_id_fk" FOREIGN KEY ("red_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkers_games" ADD CONSTRAINT "checkers_games_black_id_users_id_fk" FOREIGN KEY ("black_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkers_games_players_idx" ON "checkers_games" USING btree ("red_id","black_id");