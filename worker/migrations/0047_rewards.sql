-- Rewards — Phase 2: a credit-card rewards optimizer, sibling to Wallet's
-- Phase 1 loyalty/membership/pass/gift cards (0045_wallet.sql) but its own
-- table family, since a credit card's shape is entirely different (annual
-- fee, a base cashback rate, one or more bonus-category rows some of which
-- are only active for a date range, a list of non-cashback perks) and
-- because Part 3 of the original Wallet ask — storing actual card
-- numbers/CVV behind step-up auth and field-level encryption — will extend
-- THESE rows with encrypted fields later, not create a separate table. Same
-- off-`entities` reasoning as 0045.
--
-- Deliberately no cap-tracking (Mike's explicit call: "we can ignore
-- quarterly caps") — rewards_bonuses has no cap/limit column, and the
-- "best card" ranking in the app is a pure rate comparison, not a spend
-- tracker.
CREATE TABLE IF NOT EXISTS rewards_cards (
  id             TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL,
  network        TEXT,                        -- Visa / Mastercard / Amex / Discover / free text
  last4          TEXT,                        -- not sensitive on its own; the full number/CVV (Part 3) lands in dedicated encrypted columns added later, not here
  base_rate      REAL NOT NULL DEFAULT 1.0,   -- % cashback with no active bonus category
  annual_fee     REAL,
  always_carry   INTEGER NOT NULL DEFAULT 0,  -- Mike's own curation of "keep this in the physical wallet regardless of quarter" — not something the app infers
  active         INTEGER NOT NULL DEFAULT 1,  -- closed/no-longer-carried cards stay for history but drop out of recommendations
  color          TEXT,
  cover_art_key  TEXT,
  notes          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- One row per reward category a card offers. kind='fixed' has no
-- starts_on/ends_on (always active); kind='rotating' does, and only counts
-- toward a card's "active bonuses" when today falls in that range — this
-- is what "which cards should I carry this quarter" and "best card for X"
-- are actually computed from, no separate quarter/calendar concept needed.
-- category is free text on purpose (issuer rotating-category names are
-- often oddly specific phrases like "Wholesale clubs & select streaming
-- services," not a clean taxonomy) — matching against it in the app is a
-- simple case-insensitive substring search, not a fixed picklist.
--
-- No FK cascade relied on for delete — see 0034's own scars on this
-- (documented in 0041_vault_passwords.sql) and vault.ts's DELETE
-- /entries/:id, which walks and deletes children explicitly rather than
-- trusting `ON DELETE CASCADE` to be enforced on every D1 connection.
-- rewards.ts's card-delete route does the same for these two tables.
CREATE TABLE IF NOT EXISTS rewards_bonuses (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES rewards_cards(id),
  category   TEXT NOT NULL,
  rate       REAL NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'fixed', -- 'fixed' | 'rotating'
  starts_on  TEXT, -- YYYY-MM-DD, rotating only
  ends_on    TEXT, -- YYYY-MM-DD, rotating only
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewards_bonuses_card ON rewards_bonuses(card_id);

-- Non-cashback perks (cell phone protection, rental car CDW, purchase
-- protection, lounge access...) — plain label + optional detail, shown
-- alongside a card everywhere it appears so "what does this card actually
-- give me" is answered in one glance rather than Mike having to remember
-- it separately — this was explicitly what Card Caddy's "Find" screen
-- didn't do.
CREATE TABLE IF NOT EXISTS rewards_perks (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES rewards_cards(id),
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewards_perks_card ON rewards_perks(card_id);
