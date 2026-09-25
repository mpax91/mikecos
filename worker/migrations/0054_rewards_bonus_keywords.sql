-- Optional comma-separated merchant/keyword aliases on a rewards bonus
-- category, e.g. an "Online Shopping" bonus tagged "amazon, rhoback, etsy,
-- shein" — lets the Find search match a merchant name Mike actually types
-- ("Rhoback.com") even when it shares no text with the category's own
-- name. Free-form and entirely optional: nothing else in the app requires
-- it, and a bonus with no keywords still matches on its category name
-- exactly as before.
ALTER TABLE rewards_bonuses ADD COLUMN keywords TEXT;
