ALTER TABLE "quote_lines" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "discount_x100" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_lines_service_idx" ON "quote_lines" USING btree ("service_id");