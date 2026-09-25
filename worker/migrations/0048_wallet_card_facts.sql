-- Wallet Phase 1 round 4: a front/back image pair per card (the "cover
-- art" from 0045 IS the front image now — the editor no longer treats them
-- as separate concepts, it just calls that upload "front" and adds a
-- second "back" upload alongside it) plus a structured "Details" section,
-- the same idea as Vault's quick facts (0036_vault_facts.sql) but its own
-- table rather than reusing vault_facts directly: wallet_cards was built
-- specifically to stay off the `entities` world entirely (see 0045's own
-- comment on why), and vault_facts.entry_id — even though unenforced in
-- practice — is declared as a reference to entities(id). Keeping Wallet's
-- child tables referencing wallet_cards(id) only, the same choice already
-- made for rewards_bonuses/rewards_perks in 0047, avoids ever mixing the
-- two id spaces even nominally.
ALTER TABLE wallet_cards ADD COLUMN back_art_key TEXT;

CREATE TABLE IF NOT EXISTS wallet_card_facts (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES wallet_cards(id),
  label      TEXT NOT NULL,
  value      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_card_facts_card ON wallet_card_facts(card_id);
