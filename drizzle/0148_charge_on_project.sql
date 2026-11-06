ALTER TABLE "ticket_charges" ALTER COLUMN "ticket_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_charges" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_charges" ADD CONSTRAINT "ticket_charges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;