CREATE TABLE "pipeline_list_members" (
	"list_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "pipeline_list_members_list_id_user_id_pk" PRIMARY KEY("list_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "pipeline_lists" ADD COLUMN "everyone" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_list_members" ADD CONSTRAINT "pipeline_list_members_list_id_pipeline_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."pipeline_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_list_members" ADD CONSTRAINT "pipeline_list_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;