CREATE TABLE "store_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"supplier" text,
	"reference" text,
	"purchased_at" text,
	"note" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"receipt_id" uuid,
	"ticket_id" bigint,
	"ticket_number" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_movements" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "store_movements" ADD COLUMN "serials" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "serialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_product_id_store_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."store_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_receipts" ADD CONSTRAINT "store_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_serials" ADD CONSTRAINT "store_serials_product_id_store_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."store_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_serials" ADD CONSTRAINT "store_serials_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_serials" ADD CONSTRAINT "store_serials_receipt_id_store_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_receipts_product_idx" ON "store_receipts" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "store_receipts_supplier_idx" ON "store_receipts" USING btree ("supplier");--> statement-breakpoint
CREATE UNIQUE INDEX "store_serials_product_serial_unique" ON "store_serials" USING btree ("product_id","serial");--> statement-breakpoint
CREATE INDEX "store_serials_stock_idx" ON "store_serials" USING btree ("product_id","location_id","status");--> statement-breakpoint
ALTER TABLE "store_movements" ADD CONSTRAINT "store_movements_receipt_id_store_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."store_receipts"("id") ON DELETE set null ON UPDATE no action;