CREATE TABLE "sms_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"contact_name" text,
	"contact_id" text,
	"company_id" bigint,
	"company_name" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"ticket_id" bigint,
	"ticket_number" text,
	"auto_ticket_at" timestamp with time zone,
	"unread" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_preview" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"provider_id" text,
	"user_id" uuid,
	"auto" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_conversation_id_sms_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sms_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_conversations_phone_idx" ON "sms_conversations" USING btree ("phone","status");--> statement-breakpoint
CREATE INDEX "sms_conversations_last_idx" ON "sms_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "sms_messages_conv_idx" ON "sms_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_messages_provider_unique" ON "sms_messages" USING btree ("provider_id");--> statement-breakpoint
-- Text messages: every technician sees and answers them (once)
UPDATE "roles"
SET "permissions" = "permissions" || '["sms.view"]'::jsonb
WHERE "slug" = 'technician' AND NOT ("permissions" ? 'sms.view');
