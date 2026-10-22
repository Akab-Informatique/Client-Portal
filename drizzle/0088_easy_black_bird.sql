CREATE TABLE "passbolt_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"armored_sealed" text NOT NULL,
	"passbolt_user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passbolt_keys" ADD CONSTRAINT "passbolt_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;