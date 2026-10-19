ALTER TABLE "expense_reports" ADD COLUMN "period_start" text;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD COLUMN "period_end" text;--> statement-breakpoint
-- existing reports cover the days of their items
UPDATE "expense_reports" r SET "period_start" = x."first", "period_end" = x."last" FROM (SELECT "report_id", min("date") AS "first", max("date") AS "last" FROM "expenses" WHERE "report_id" IS NOT NULL GROUP BY "report_id") x WHERE x."report_id" = r."id";
