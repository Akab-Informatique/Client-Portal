CREATE TABLE "dashboard_members" (
	"dashboard_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_members_dashboard_id_user_id_pk" PRIMARY KEY("dashboard_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "team_access" text DEFAULT 'view' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "default_dashboard_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_members_user_idx" ON "dashboard_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_default_dashboard_id_dashboards_id_fk" FOREIGN KEY ("default_dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE set null ON UPDATE no action;