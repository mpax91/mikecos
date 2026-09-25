-- Wallet Categories — a Settings-managed pick list for wallet_cards.category
-- (see 0045_wallet.sql). Deliberately NOT a foreign key: category stays a
-- plain free-text column on wallet_cards so a one-off card is never blocked
-- by a missing preset, and deleting a category here never has to touch or
-- orphan existing cards — this table is purely what Settings and the card
-- editor's dropdown *suggest*, not what a card is allowed to hold. The
-- Wallet page's own filter chips are derived straight from whatever
-- categories are actually in use on real cards, not from this list.
CREATE TABLE IF NOT EXISTS wallet_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO wallet_categories (id, name, sort_order, created_at) VALUES
  ('retail', 'Retail', 0, datetime('now')),
  ('grocery', 'Grocery', 1, datetime('now')),
  ('pharmacy', 'Pharmacy', 2, datetime('now')),
  ('gym-fitness', 'Gym & Fitness', 3, datetime('now')),
  ('parks-recreation', 'Parks & Recreation', 4, datetime('now')),
  ('membership', 'Membership', 5, datetime('now')),
  ('gift-card', 'Gift Card', 6, datetime('now')),
  ('local-shop', 'Local Shop', 7, datetime('now')),
  ('other', 'Other', 8, datetime('now'));
