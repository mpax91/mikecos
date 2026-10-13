-- Which path last pulled Bing successfully: 'worker' (the Cloudflare cron /
-- Sync Now) or 'github' (the nightly GitHub Actions job that posts to
-- POST /api/bee/bing/import — Bing throttles Cloudflare's shared IPs).
ALTER TABLE bee_keys ADD COLUMN bing_last_ok_via TEXT;
