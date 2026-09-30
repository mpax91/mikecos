-- Bottle/can photos for Bar items. One photo per item — unlike Wallet cards
-- (0070/0071_wallet_card_*art_orientation.sql), a bottle has no meaningful
-- "back" to photograph separately. Orientation is detected client-side from
-- the uploaded image's own pixel dimensions, same pattern as Wallet card
-- art — Mike never picks it. Defaults to 'portrait' (rather than Wallet's
-- 'landscape' default) since most bottle photos are vertical; a label or
-- case shot that comes in landscape is still auto-detected correctly once
-- a photo is actually uploaded.
ALTER TABLE bar_items ADD COLUMN photo_key TEXT;
ALTER TABLE bar_items ADD COLUMN photo_mime TEXT;
ALTER TABLE bar_items ADD COLUMN photo_orientation TEXT NOT NULL DEFAULT 'portrait';
