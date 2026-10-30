ALTER TABLE "ticket_board_cards" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_boards" ADD COLUMN "user_id" uuid;--> statement-breakpoint
UPDATE "ticket_boards" SET "user_id" = "created_by" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "ticket_boards" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "ticket_board_cards" c SET "user_id" = b."user_id" FROM "ticket_boards" b WHERE c."board_id" = b."id";--> statement-breakpoint
DELETE FROM "ticket_board_cards" WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "ticket_board_cards" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_board_cards" DROP CONSTRAINT "ticket_board_cards_pkey";--> statement-breakpoint
ALTER TABLE "ticket_board_cards" ADD CONSTRAINT "ticket_board_cards_user_id_ticket_id_pk" PRIMARY KEY("user_id","ticket_id");--> statement-breakpoint
ALTER TABLE "ticket_meta" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "ticket_layout" text;--> statement-breakpoint
ALTER TABLE "ticket_boards" ADD CONSTRAINT "ticket_boards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
