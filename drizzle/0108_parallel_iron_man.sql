ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'upload' NOT NULL;
