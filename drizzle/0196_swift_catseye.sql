CREATE TABLE "proj_archive_skips" (
	"legacy_id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "proj_archive_skips" ADD CONSTRAINT "proj_archive_skips_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;