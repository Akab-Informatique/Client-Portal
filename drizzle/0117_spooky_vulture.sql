ALTER TABLE "meeting_points" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "meeting_points" m SET "position" = s.rn FROM (SELECT "id", row_number() OVER (ORDER BY "created_at") AS rn FROM "meeting_points") s WHERE m."id" = s."id";
