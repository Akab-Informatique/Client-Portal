CREATE TABLE "autotask_authors" (
	"entity" text NOT NULL,
	"autotask_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autotask_authors_entity_autotask_id_pk" PRIMARY KEY("entity","autotask_id")
);
--> statement-breakpoint
ALTER TABLE "autotask_authors" ADD CONSTRAINT "autotask_authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autotask_authors_ticket_idx" ON "autotask_authors" USING btree ("ticket_id");