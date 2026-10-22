ALTER TABLE "expense_favorites" ADD COLUMN "from_place" text;--> statement-breakpoint
ALTER TABLE "expense_favorites" ADD COLUMN "to_place" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "from_place" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "to_place" text;