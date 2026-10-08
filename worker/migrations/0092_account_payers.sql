-- Account payers: which payment method pays each account (Mike, 2026-10-07).
-- An "account" is a Vault entry (a Statements-backed one like "ADT Home
-- Security", or any hand-made entry like Netflix), so accounts with no
-- statement folder can use it too. One row per account.
--
-- mode: 'autopay' = the account charges the card by itself;
--       'on_file' = the card is saved with them and Mike clicks Pay.
-- Accounts where the number is typed in each time get no row — nothing to
-- update when a card is replaced.
--
-- The payer is a Wallet payment card (payment_card_id) or, when it isn't a
-- card (a credit card paid from checking), free text (payer_text). Only the
-- nickname + last 4 are ever shown; full numbers stay in payment_cards.
CREATE TABLE IF NOT EXISTS account_payers (
  id              TEXT PRIMARY KEY,
  entry_id        TEXT NOT NULL UNIQUE,        -- entities.id (type vault_entry)
  mode            TEXT NOT NULL DEFAULT 'autopay', -- autopay | on_file
  payment_card_id TEXT REFERENCES payment_cards(id),
  payer_text      TEXT,
  due_day         INTEGER,                     -- 1–31; used when no statement shows a due date
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_payers_card ON account_payers (payment_card_id);

-- Auto-updating Quick Facts (vault_facts.managed_key 'pay:*') that Mike has
-- edited or deleted. Editing one makes it his own fact (managed_key NULL);
-- deleting one keeps it deleted. Either way the key is recorded here so
-- the sync never re-creates it.
CREATE TABLE IF NOT EXISTS vault_fact_releases (
  entry_id    TEXT NOT NULL,
  managed_key TEXT NOT NULL,
  released_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, managed_key)
);
