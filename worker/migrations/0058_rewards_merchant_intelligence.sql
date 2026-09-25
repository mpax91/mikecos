-- Rewards Find currently only matches a bonus's own category text or the
-- keywords typed directly onto it — it has no idea "Rhoback" is an online
-- clothing store, "Fios" is Verizon, or "Grubhub" is food delivery. That
-- knowledge doesn't belong hand-maintained by Mike (same reasoning
-- 0054/0055's keyword/online-only fields exist), so it's the same
-- workflow as 0057_rewards_import.sql: the quarterly research project (or
-- an in-app "teach MikeOS this merchant" quick-add when Find comes up
-- empty) builds this directory, and Find resolves an unrecognized query
-- against it before giving up.
--
-- `category` is free text meant to line up with an existing bonus
-- category or perk category (e.g. "Online Shopping", "Phone/Wireless",
-- "Streaming Services", "Car Rental") — matched the same plain-substring
-- way everything else in Rewards is, not a foreign key, for the same
-- "issuer category names are odd phrases, not a clean taxonomy" reason
-- 0047's own comment gives for rewards_bonuses.category.
CREATE TABLE IF NOT EXISTS rewards_merchants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,             -- canonical display name, e.g. "Rhoback"
  aliases    TEXT,                      -- comma-separated, e.g. "rhoback.com"
  category   TEXT NOT NULL,             -- e.g. "Online Shopping"
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewards_merchants_name ON rewards_merchants(name);

-- A perk (0047_rewards.sql's rewards_perks) is a fixed benefit, not a
-- cashback rate, so it never showed up in Find's ranking at all — only
-- as a fixed "here's everything this card offers" list on whichever card
-- happened to already be in the results. Tagging a perk with the spend
-- category it actually applies to ("Car Rental" on a damage-waiver perk,
-- "Phone/Wireless" on a cell-protection perk) is what lets Find surface
-- "use this card for the rental car insurance" even when no cashback
-- category matches at all. Free text, optional — a perk with no category
-- (interest-free financing, an intro APR) just never surfaces there.
ALTER TABLE rewards_perks ADD COLUMN category TEXT;

-- Bank-portal targeted offers (Chase Offers, Amex Offers, Discover
-- Deals — "$10 off $25 at Grubhub") are personalized and change weekly,
-- sitting behind Mike's own login on each issuer's site — nothing a
-- research project can discover on its own. This is deliberately a
-- manual, lightweight table: Mike jots one down the moment he notices it
-- (from Find's "no card offers on file" prompt, or the card detail view),
-- and it ages out naturally via expires_on rather than needing anyone to
-- remember to remove it.
CREATE TABLE IF NOT EXISTS rewards_offers (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES rewards_cards(id),
  merchant    TEXT NOT NULL,            -- e.g. "Grubhub"
  description TEXT NOT NULL,            -- e.g. "$10 off $25, activate in the Chase app"
  expires_on  TEXT,                     -- YYYY-MM-DD, optional
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewards_offers_card ON rewards_offers(card_id);
