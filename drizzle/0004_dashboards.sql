CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"owner_id" uuid,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_slug_unique" ON "dashboards" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "dashboards_owner_idx" ON "dashboards" USING btree ("owner_id");