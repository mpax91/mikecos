-- Rewards: a "phone-wallet" earn rate, plus Mike's new Samsung Galaxy Card.
--
-- The Samsung Galaxy Card (Barclays, Visa, $0 fee, launched July 2026) pays
-- 3% on ANY purchase made through Samsung Wallet, but only 1% when the
-- physical card is swiped/tapped. That's neither a base rate nor a
-- category bonus — it's a rate conditioned on HOW you pay — so it gets its
-- own two columns rather than a fake "Everything" bonus row:
--   mobile_wallet_rate  % earned paying through the phone wallet (null = n/a)
--   mobile_wallet_name  which wallet ("Samsung Wallet")
-- Ranking (src/utils/rewards.ts): it wins Find / headline answers labelled
-- "pay with Samsung Wallet", but never pulls the card into the physical
-- carry plan, and never overrides the card's own online-only bonus
-- (a streaming subscription can't be tapped with a phone).
ALTER TABLE rewards_cards ADD COLUMN mobile_wallet_rate REAL;
ALTER TABLE rewards_cards ADD COLUMN mobile_wallet_name TEXT;

-- Seed the card (Mike, 2026-10-23: "get this card into the card database
-- and wallet and update rewards"). Terms per Samsung Newsroom / NerdWallet
-- launch coverage, July 2026. Guarded so a re-run, or a Samsung card Mike
-- already added by hand, never duplicates. last4 / number / expiry / CVV
-- are left for Mike to fill in on the Wallet card in the app.
INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, import_key, mobile_wallet_rate, mobile_wallet_name, created_at, updated_at)
SELECT 'rw-samsung-galaxy', 'Samsung Galaxy Card', 'Visa', NULL, 1.0, 0, 0, 1, '#3B5BA9', NULL,
  'Barclays-issued Visa. The physical card earns only 1% — pay with Samsung Wallet (tap the phone) for 3%. 5% direct from Samsung (Samsung.com, Experience Stores, Galaxy Store, Care+, Smart TV Store); 2% on eligible streaming. Uncapped, never expires, redeem anytime as cash. Welcome: $200 after $2,000 spent in the first 90 days.',
  (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM rewards_cards), 'samsung-galaxy-card', 3.0, 'Samsung Wallet',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM rewards_cards WHERE import_key = 'samsung-galaxy-card' OR nickname LIKE '%samsung%');

INSERT INTO rewards_bonuses (id, card_id, category, rate, kind, starts_on, ends_on, keywords, online_only, exclude_from_carry, sort_order, created_at)
SELECT 'rwb-samsung-direct', 'rw-samsung-galaxy', 'Samsung (direct)', 5.0, 'fixed', NULL, NULL,
  'samsung, samsung.com, galaxy store, samsung experience store, samsung care, smart tv store, samsung vip', 0, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rewards_cards WHERE id = 'rw-samsung-galaxy')
  AND NOT EXISTS (SELECT 1 FROM rewards_bonuses WHERE id = 'rwb-samsung-direct');

INSERT INTO rewards_bonuses (id, card_id, category, rate, kind, starts_on, ends_on, keywords, online_only, exclude_from_carry, sort_order, created_at)
SELECT 'rwb-samsung-streaming', 'rw-samsung-galaxy', 'Streaming', 2.0, 'fixed', NULL, NULL,
  'netflix, disney, spotify', 1, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rewards_cards WHERE id = 'rw-samsung-galaxy')
  AND NOT EXISTS (SELECT 1 FROM rewards_bonuses WHERE id = 'rwb-samsung-streaming');

INSERT INTO rewards_perks (id, card_id, label, description, category, sort_order, created_at)
SELECT 'rwp-samsung-welcome', 'rw-samsung-galaxy', 'Welcome bonus', '$200 cash back after $2,000 in purchases in the first 90 days.', NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rewards_cards WHERE id = 'rw-samsung-galaxy')
  AND NOT EXISTS (SELECT 1 FROM rewards_perks WHERE id = 'rwp-samsung-welcome');

INSERT INTO rewards_perks (id, card_id, label, description, category, sort_order, created_at)
SELECT 'rwp-samsung-vip', 'rw-samsung-galaxy', 'Samsung VIP Advantage 20% off', '20% off a Samsung VIP Advantage membership, plus 5% back buying or renewing it.', 'Samsung', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rewards_cards WHERE id = 'rw-samsung-galaxy')
  AND NOT EXISTS (SELECT 1 FROM rewards_perks WHERE id = 'rwp-samsung-vip');

-- The Wallet (payment card database) entry, linked to the Rewards card so
-- the Rewards fact and "Wallet · …" links work once a statement folder
-- exists. Only seeded when the Rewards card above was seeded by this
-- migration and no Samsung Wallet card exists yet.
INSERT INTO payment_cards (id, nickname, card_type, network, issuer, last4, name_on_card, expiry_month, expiry_year, number_enc, cvv_enc, billing_zip, color, cover_art_key, back_art_key, notes, reward_worthy, rewards_card_id, active, sort_order, created_at, updated_at)
SELECT 'pc-samsung-galaxy', 'Samsung Galaxy Card', 'credit', 'Visa', 'Barclays', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '#3B5BA9', NULL, NULL,
  'Pay with Samsung Wallet for 3% (physical card = 1%). Add last 4, expiry, number & CVV.', 1, 'rw-samsung-galaxy', 1,
  (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM payment_cards), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rewards_cards WHERE id = 'rw-samsung-galaxy')
  AND NOT EXISTS (SELECT 1 FROM payment_cards WHERE id = 'pc-samsung-galaxy' OR nickname LIKE '%samsung%');
