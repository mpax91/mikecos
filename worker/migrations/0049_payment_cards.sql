-- Wallet Part 3: a secure "Payment Cards" vault. Widened from the
-- original "credit cards" scope: a debit card is the same kind of object
-- (a number, an expiry, a CVV) and just never earns rewards — Mike's own
-- call when asked where debit cards belonged. card_type distinguishes the
-- two; nothing else about the schema differs by type.
--
-- Its own table, off-entities like every other Wallet table (see 0045's
-- comment on why), and deliberately NOT rewards_cards (0047) — a payment
-- card's sensitive fields have nothing to do with a reward card's bonus/
-- perk rows. A reward-worthy payment card instead LINKS to a rewards_cards
-- row via rewards_card_id, set explicitly (never silently) by
-- paymentCards.ts's routes: Mike either links to one of his existing ~15
-- Rewards cards or has a new one created, so entering a card here never
-- creates a duplicate in Rewards. Unflagging "reward worthy" clears the
-- link but never deletes the Rewards card itself — that row, and whatever
-- bonus/perk rows it carries, is only ever deleted from the Rewards tab
-- directly.
--
-- number_enc/cvv_enc are AES-256-GCM ciphertext (see cryptoField.ts),
-- keyed by the PAYMENT_CARD_ENC_KEY Worker secret. last4 stays plain TEXT
-- since it isn't sensitive on its own and needs to be fast to show in the
-- list view without a decrypt round trip; the full number and CVV are
-- never included in the list response at all, only via the explicit
-- GET /cards/:id/reveal Mike taps for.
CREATE TABLE IF NOT EXISTS payment_cards (
  id              TEXT PRIMARY KEY,
  nickname        TEXT NOT NULL,
  card_type       TEXT NOT NULL DEFAULT 'credit', -- 'credit' | 'debit'
  network         TEXT,                           -- Visa / Mastercard / Amex / Discover / free text
  issuer          TEXT,                           -- the bank/credit union
  last4           TEXT,
  name_on_card    TEXT,
  expiry_month    INTEGER,
  expiry_year     INTEGER,
  number_enc      TEXT,
  cvv_enc         TEXT,
  billing_zip     TEXT,
  color           TEXT,
  cover_art_key   TEXT,
  back_art_key    TEXT,
  notes           TEXT,
  reward_worthy   INTEGER NOT NULL DEFAULT 0,
  rewards_card_id TEXT REFERENCES rewards_cards(id),
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_cards_rewards_card ON payment_cards(rewards_card_id);
