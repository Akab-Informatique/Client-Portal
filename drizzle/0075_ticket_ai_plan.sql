CREATE TABLE "ticket_ai_plan" (
	"user_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"planned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_ai_plan_user_id_ticket_id_pk" PRIMARY KEY("user_id","ticket_id")
);
--> statement-breakpoint
ALTER TABLE "ticket_ai_plan" ADD CONSTRAINT "ticket_ai_plan_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;