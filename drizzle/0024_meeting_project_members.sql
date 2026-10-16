CREATE TABLE "meeting_project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "meeting_project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_project_members" ADD CONSTRAINT "meeting_project_members_project_id_meeting_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."meeting_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_project_members" ADD CONSTRAINT "meeting_project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;