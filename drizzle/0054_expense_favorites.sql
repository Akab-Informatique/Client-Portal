CREATE TABLE "expense_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity_x100" integer,
	"amount_cents" bigint,
	"client_id" uuid,
	"billable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_favorites" ADD CONSTRAINT "expense_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_favorites" ADD CONSTRAINT "expense_favorites_type_id_expense_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."expense_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_favorites" ADD CONSTRAINT "expense_favorites_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_favorites_user_idx" ON "expense_favorites" USING btree ("user_id");