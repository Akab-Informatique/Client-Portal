CREATE TABLE "user_sort_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"item_key" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "depends_on_id" uuid;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "sort_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sort_orders" ADD CONSTRAINT "user_sort_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sort_orders_unique" ON "user_sort_orders" USING btree ("user_id","scope","item_key");--> statement-breakpoint
CREATE INDEX "user_sort_orders_scope_idx" ON "user_sort_orders" USING btree ("user_id","scope","position");--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE set null ON UPDATE no action;