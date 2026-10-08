-- Wallet: bank accounts (checking / savings) live in payment_cards as
-- card_type = 'bank', so everything built on payment cards — Pays For,
-- the Paid With picker (account_payers.payment_card_id), "removed from
-- Wallet" flags, search, Details facts — works for them unchanged.
-- The full account number goes in number_enc (AES-256-GCM, same
-- PAYMENT_CARD_ENC_KEY, reveal-on-tap only); last4 stays plain. The ABA
-- routing number is printed on every check and isn't secret, so it's
-- plain text. Card-only columns (expiry, CVV, network…) stay NULL.
ALTER TABLE payment_cards ADD COLUMN account_kind TEXT;      -- checking | savings | money_market | cd | other
ALTER TABLE payment_cards ADD COLUMN routing_number TEXT;
ALTER TABLE payment_cards ADD COLUMN wire_routing_number TEXT; -- only when the bank uses a different one for wires
ALTER TABLE payment_cards ADD COLUMN account_owners TEXT;     -- e.g. "Michael A Palladino, Cornelia C Palladino (Joint)"
