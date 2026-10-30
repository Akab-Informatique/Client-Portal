CREATE TABLE "payroll_plans" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"weekly_cents" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_plans" ADD CONSTRAINT "payroll_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;