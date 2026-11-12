CREATE TABLE "client_user_grants" (
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_user_grants_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "self_managed" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_client_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD COLUMN "by_delegate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "akab_taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "help_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "client_user_grants" ADD CONSTRAINT "client_user_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_user_grants" ADD CONSTRAINT "client_user_grants_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_user_grants" ADD CONSTRAINT "client_user_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_user_grants" ADD CONSTRAINT "client_user_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_client_id_clients_id_fk" FOREIGN KEY ("active_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;