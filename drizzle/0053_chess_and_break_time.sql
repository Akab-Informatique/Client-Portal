CREATE TABLE "breakroom_usage" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"used_seconds" integer DEFAULT 0 NOT NULL,
	"last_beat_at" timestamp with time zone,
	CONSTRAINT "breakroom_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "chess_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"white_id" uuid NOT NULL,
	"black_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"fen" text NOT NULL,
	"pgn" text DEFAULT '' NOT NULL,
	"last_move" text,
	"result" text,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "breakroom_usage" ADD CONSTRAINT "breakroom_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chess_games" ADD CONSTRAINT "chess_games_white_id_users_id_fk" FOREIGN KEY ("white_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chess_games" ADD CONSTRAINT "chess_games_black_id_users_id_fk" FOREIGN KEY ("black_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chess_games_players_idx" ON "chess_games" USING btree ("white_id","black_id");