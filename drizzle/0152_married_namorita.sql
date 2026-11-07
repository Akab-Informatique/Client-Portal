CREATE TABLE "rmm_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" text NOT NULL,
	"site_uid" text NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"external_ip" text DEFAULT '' NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"last_user" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"reboot_required" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp with time zone,
	"last_reboot" timestamp with time zone,
	"last_audit" timestamp with time zone,
	"patch_status" text DEFAULT '' NOT NULL,
	"patches_pending" integer DEFAULT 0 NOT NULL,
	"antivirus" text DEFAULT '' NOT NULL,
	"antivirus_status" text DEFAULT '' NOT NULL,
	"warranty_date" text DEFAULT '' NOT NULL,
	"portal_url" text,
	"remote_url" text,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rmm_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"client_id" uuid,
	"device_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rmm_sites" ADD CONSTRAINT "rmm_sites_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rmm_devices_uid_idx" ON "rmm_devices" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "rmm_devices_site_idx" ON "rmm_devices" USING btree ("site_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "rmm_sites_uid_idx" ON "rmm_sites" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "rmm_sites_client_idx" ON "rmm_sites" USING btree ("client_id");