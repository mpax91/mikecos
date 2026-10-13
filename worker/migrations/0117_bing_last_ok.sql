-- Bing: remember when a sync last SUCCEEDED (Mike, 2026-10-13).
-- bing_last_sync_at is stamped on every attempt, including ones Bing
-- throttles (ThrottleIP on Cloudflare's shared IPs), so on its own it made
-- a failed retry look like fresh data. NULL = unknown (before this column).
ALTER TABLE bee_keys ADD COLUMN bing_last_ok_at TEXT;
