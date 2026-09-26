-- Lets an email account use an uploaded image (e.g. the provider's real
-- logo, or a photo) as its icon instead of an emoji character. The emoji
-- field (email_accounts.icon) stays as the fallback/default — Inbox and
-- Settings show the image when this is set, the emoji otherwise. Storage
-- follows the same R2-backed pattern as payment_cards.cover_art_key: this
-- column holds the R2 object key, never the image itself.
ALTER TABLE email_accounts ADD COLUMN icon_image_key TEXT;
