ALTER TABLE "user_preferences" ADD COLUMN "outlook" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- whoever already linked a mailbox keeps the Outlook module
INSERT INTO "user_preferences" ("user_id", "outlook") SELECT DISTINCT "user_id", true FROM "mail_accounts" ON CONFLICT ("user_id") DO UPDATE SET "outlook" = true;
