ALTER TABLE "push_devices" ADD COLUMN "notify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "push_details" boolean DEFAULT false NOT NULL;