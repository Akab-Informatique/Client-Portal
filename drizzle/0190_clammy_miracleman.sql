ALTER TABLE "ticket_charges" ADD COLUMN "proj_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_charges" ADD CONSTRAINT "ticket_charges_proj_id_proj_projects_id_fk" FOREIGN KEY ("proj_id") REFERENCES "public"."proj_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_charges_proj_idx" ON "ticket_charges" USING btree ("proj_id");