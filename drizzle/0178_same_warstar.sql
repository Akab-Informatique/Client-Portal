CREATE TABLE "tv_bots" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_sealed" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tv_status" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"label" text,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tv_status" ADD CONSTRAINT "tv_status_bot_id_tv_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."tv_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tv_bots_name_key_unique" ON "tv_bots" USING btree ("name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tv_bots_key_hash_unique" ON "tv_bots" USING btree ("key_hash");