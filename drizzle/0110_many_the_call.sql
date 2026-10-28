ALTER TABLE "clients" ADD COLUMN "portal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- a company that already has an active client account keeps its portal open
UPDATE "clients" SET "portal_enabled" = true WHERE EXISTS (SELECT 1 FROM "users" WHERE "users"."client_id" = "clients"."id" AND "users"."kind" = 'client' AND "users"."active");
