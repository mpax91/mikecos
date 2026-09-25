-- Wallet Part 3 round 2 — a structured "Details" section on Payment Cards,
-- same idea and same shape as Wallet's own card facts (0048) and Vault's
-- quick facts (0036): a plain label/value list, no field registry, added
-- inline. Its own table, referencing payment_cards(id) only, for the same
-- reason 0048's comment gives for wallet_card_facts — keeping each Wallet
-- sub-feature's child rows pointed at its own parent table rather than
-- ever crossing into another id space.
CREATE TABLE IF NOT EXISTS payment_card_facts (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES payment_cards(id),
  label      TEXT NOT NULL,
  value      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_card_facts_card ON payment_card_facts(card_id);
