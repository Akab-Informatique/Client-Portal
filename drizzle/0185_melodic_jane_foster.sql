CREATE TABLE "proj_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid,
	"name" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"data" text NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "billing_mode" text DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "hourly_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "fixed_price_cents" integer;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "bank_expires_on" text;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "invoiced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD COLUMN "legacy_id" uuid;--> statement-breakpoint
ALTER TABLE "proj_files" ADD CONSTRAINT "proj_files_project_id_proj_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_files" ADD CONSTRAINT "proj_files_note_id_proj_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."proj_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proj_files_project_idx" ON "proj_files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "proj_files_note_idx" ON "proj_files" USING btree ("note_id");--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proj_projects" ADD CONSTRAINT "proj_projects_legacy_id_unique" UNIQUE("legacy_id");