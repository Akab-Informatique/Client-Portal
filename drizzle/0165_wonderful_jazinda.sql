CREATE TABLE "pipeline_entry_items" (
	"entry_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	CONSTRAINT "pipeline_entry_items_entry_id_item_id_pk" PRIMARY KEY("entry_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "pipeline_task_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_entry_items" ADD CONSTRAINT "pipeline_entry_items_entry_id_timesheet_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."timesheet_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_entry_items" ADD CONSTRAINT "pipeline_entry_items_item_id_pipeline_checklist_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pipeline_checklist"("id") ON DELETE cascade ON UPDATE no action;