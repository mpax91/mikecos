-- Task reminders as push notifications (Mike, 2026-10-14): a task with a
-- due date AND a time pings every subscribed device (desktop Chrome →
-- Windows notification; Android PWA → Android notification) when its time
-- arrives. Standard Web Push (VAPID + aes128gcm) — no third-party service.

-- One row per browser/device that turned notifications on.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,          -- browser's public key (base64url)
  auth TEXT NOT NULL,            -- browser's auth secret (base64url)
  label TEXT,                    -- "Chrome on Windows", "Android" …
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT
);

-- The app's own VAPID key pair, made on first use (private half encrypted
-- with CLOUD_ACCOUNT_ENC_KEY) so no new Worker secret is needed.
CREATE TABLE push_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vapid_public TEXT NOT NULL,    -- raw uncompressed P-256 point, base64url
  vapid_private_enc TEXT NOT NULL, -- JWK JSON, encrypted
  created_at TEXT NOT NULL
);

-- What was already sent. fire_key = 'YYYY-MM-DD HH:MM' the task was due, so
-- moving a task to another time pings again at the new time.
CREATE TABLE task_push_log (
  entity_id TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  devices INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, fire_key)
);
