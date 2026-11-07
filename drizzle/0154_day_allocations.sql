CREATE TABLE "pipeline_day_alloc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"key" text NOT NULL,
	"minutes" integer NOT NULL,
	"source" text NOT NULL,
	"position" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_day_alloc" ADD CONSTRAINT "pipeline_day_alloc_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_day_alloc_unique" ON "pipeline_day_alloc" USING btree ("user_id","date","key","source");