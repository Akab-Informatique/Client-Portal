ALTER TABLE "client_contacts" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "client_contacts_primary_idx" ON "client_contacts" USING btree ("client_id") WHERE "client_contacts"."is_primary";--> statement-breakpoint
-- a client with only one contact: that contact is the main one, and the billing one when none is set
UPDATE "client_contacts" cc SET "is_primary" = true
WHERE cc."active" AND (SELECT count(*) FROM "client_contacts" x WHERE x."client_id" = cc."client_id" AND x."active") = 1;
--> statement-breakpoint
UPDATE "clients" c SET "invoice" = COALESCE(c."invoice", '{}'::jsonb) || jsonb_build_object('billingContactId', cc."id", 'billingEmail', cc."email")
FROM "client_contacts" cc
WHERE cc."client_id" = c."id" AND cc."is_primary" AND coalesce(trim(cc."email"), '') <> '' AND coalesce(trim(c."invoice"->>'billingEmail'), '') = '';
