-- Wallet — Phase 1: loyalty/membership/pass/gift cards for quick reference
-- and in-person barcode scanning. Deliberately NOT built on the `entities`
-- framework (unlike Vault, which layers is_jot/is_list/is_password flags on
-- top of it) — a wallet card's shape (barcode payload, PIN, balance, cover
-- art, category) doesn't map onto notes/tasks/projects, and staying off
-- `entities` entirely sidesteps ever touching its CHECK (type IN (...))
-- constraint again (see 0041_vault_passwords.sql's own comment on the 0034
-- incident that lost 75 rows doing exactly that). Same "own flat table"
-- choice as quick_links (0028_quick_links.sql), whose shape and CRUD
-- pattern this closely follows.
--
-- category is free text, not an enum — the point of Wallet is never
-- blocking a card that doesn't fit a preset list (a federal recreation
-- pass, a county park pass, a local shop card, a gift card, alongside
-- ordinary store loyalty). The UI offers a curated pick-list of common
-- categories as a starting point but always allows free entry.
--
-- barcode_type = 'none' covers cards with no scannable code at all (some
-- passes are only checked visually). barcode_value holds the actual scan
-- payload; display_number is the human-readable fallback rendered as text
-- (under the barcode, or in place of it when there is none) — kept
-- separate from barcode_value since the two aren't always the same string.
--
-- pin_code and balance are plain TEXT, same as vault_credentials.password —
-- consistent with this app's existing security posture for reference data
-- (see MikeOS Development project notes on the Wallet security plan: masked
-- display, step-up auth on reveal, and field-level encryption land as a
-- later pass, not blocking Phase 1's loyalty/pass/gift-card scope, which
-- carries no full card numbers).
CREATE TABLE IF NOT EXISTS wallet_cards (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'Other',
  barcode_type   TEXT NOT NULL DEFAULT 'code128', -- 'code128' | 'qr' | 'upc' | 'ean13' | 'none'
  barcode_value  TEXT,
  display_number TEXT,
  pin_code       TEXT,
  balance        TEXT,
  notes          TEXT,
  color          TEXT,
  cover_art_key  TEXT,
  cover_art_mime TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_cards_category ON wallet_cards(category);
CREATE INDEX IF NOT EXISTS idx_wallet_cards_pinned ON wallet_cards(pinned);
