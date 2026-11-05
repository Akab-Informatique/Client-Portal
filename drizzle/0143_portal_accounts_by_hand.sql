-- Client portal accounts are made by hand now. The accounts the portal made on its own for every contact of a company
-- whose portal is still closed (never signed in, still on their first password) are turned off, so that opening the
-- company's portal does not let them in: a person is invited or created one by one from their contact.
UPDATE "users" SET "active" = false
WHERE "kind" = 'client'
  AND "last_login_at" IS NULL
  AND "must_change_password" = true
  AND "client_id" IN (SELECT "id" FROM "clients" WHERE "portal_enabled" = false);
