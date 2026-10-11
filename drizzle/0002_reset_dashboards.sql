-- Dashboard cleared until the widgets to keep are chosen: drop saved layouts
-- so every user starts from the (empty) default.
UPDATE "user_preferences" SET "dashboard" = NULL;
