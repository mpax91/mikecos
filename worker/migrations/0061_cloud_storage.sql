-- Cloud — a Windows-Explorer-style view over Mike's real cloud storage
-- accounts (Google Drive, OneDrive, Dropbox, Box), each connected via OAuth.
-- See worker/src/cloud.ts and worker/src/cloudProviders/*.ts.
--
-- One row per connected ACCOUNT, not per file — MikeOS never mirrors the
-- file tree into D1, it calls each provider's API live on every browse.
-- That's deliberate: cloud storage is enormous and constantly changing, so
-- unlike Bookmarks (a small, periodic, fully-owned snapshot) there's no
-- "import" step here, just an always-live view through the account's
-- tokens. Multiple rows can share the same provider (e.g. two Google Drive
-- accounts), which is why `provider` isn't the primary key.
CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google_drive', 'onedrive', 'dropbox', 'box')),
  label TEXT NOT NULL, -- Mike's own name for the account, e.g. "Personal" / "Origin Work"
  account_email TEXT, -- from the provider's own profile endpoint, best-effort
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT, -- nullable: a provider can decline to re-issue one on later consents
  token_expires_at TEXT NOT NULL,
  scope TEXT,
  icon TEXT NOT NULL DEFAULT '☁️',
  color TEXT NOT NULL DEFAULT '#2F4A3C',
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_error TEXT,
  -- Storage quota is cached rather than fetched on every page load — see
  -- the QUOTA_STALE_MS constant in cloud.ts for the refresh window.
  quota_used_bytes INTEGER,
  quota_total_bytes INTEGER, -- NULL means "unlimited/unreported", not zero
  quota_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Short-lived rows bridging the redirect out to a provider's consent screen
-- and the callback coming back — the state param round-trips as the row's
-- id, so the callback can recover which provider/label this was without
-- trusting anything the query string itself claims. Cleaned up (deleted)
-- the moment the callback consumes them; a periodic delete of anything
-- older than OAUTH_STATE_TTL_MS in cloud.ts handles ones that never came back.
CREATE TABLE IF NOT EXISTS cloud_oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
