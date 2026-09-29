-- Wallet: front and back photos can be different orientations on the same
-- physical card (Mike's actual example: a card with a vertical front and a
-- horizontal back), so a single art_orientation flag per card (0070)
-- wasn't enough — it correctly turned the front upright but would have
-- forced a landscape back into a portrait box too, or vice versa.
--
-- Renames the 0070 column to make clear it's front-only now that there
-- are two, and adds its back-only counterpart. Same "detected
-- automatically from the uploaded photo's own pixel dimensions, Mike
-- never picks it" behavior as before, just applied independently to each
-- side's own image instead of once for the whole card.
ALTER TABLE wallet_cards RENAME COLUMN art_orientation TO cover_art_orientation;
ALTER TABLE wallet_cards ADD COLUMN back_art_orientation TEXT NOT NULL DEFAULT 'landscape';
