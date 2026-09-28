-- Adds the category presets Mike's Wallet redesign called for specifically
-- (Car, Military, Travel, ID) on top of 0046's original 9. Grocery and
-- Parks & Recreation already existed. Same free-text/no-FK reasoning as
-- 0046 — this only affects what the category picker suggests, never what a
-- card is allowed to hold.
--
-- 'id' is also what the Card Database's Loyalty category pills key off of
-- to show ID cards (license/passport/military ID) as their own filter —
-- see wallet.ts's id_number_enc field (0066) for where the actual sensitive
-- number lives.
INSERT OR IGNORE INTO wallet_categories (id, name, sort_order, created_at) VALUES
  ('car', 'Car', 9, datetime('now')),
  ('military', 'Military', 10, datetime('now')),
  ('travel', 'Travel', 11, datetime('now')),
  ('id', 'ID', 12, datetime('now'));
