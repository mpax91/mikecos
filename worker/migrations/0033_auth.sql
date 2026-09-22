-- App-wide authentication: gates every /api/* route (except the auth
-- routes themselves) behind either a WebAuthn platform credential
-- (Face ID / Touch ID / Android fingerprint on phones & tablets) or a
-- plain PIN (Windows desktop/laptop — deliberately NOT WebAuthn/Windows
-- Hello, since Mike doesn't want OS-level prompts on those two machines).
--
-- Single-user app: there is no `users` table anywhere in MikeOS and this
-- doesn't add one. Everything here is scoped to "the one person who owns
-- this instance," identified only by which credential they used to log in.

-- One row per registered device/credential. `type` distinguishes the two
-- login mechanisms; the columns each one actually uses are nullable so a
-- single table can hold both without two near-duplicate schemas.
CREATE TABLE auth_credentials (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webauthn', 'pin')),
  device_label TEXT NOT NULL,

  -- webauthn-only fields
  webauthn_credential_id TEXT,      -- base64url credential ID (unique per authenticator)
  webauthn_public_key TEXT,         -- base64url-encoded COSE public key
  webauthn_counter INTEGER,         -- signature counter, for clone detection
  webauthn_transports TEXT,         -- JSON string array, e.g. ["internal"]

  -- pin-only fields (one PIN is shared across both Windows machines, since
  -- a PIN isn't hardware-bound the way a WebAuthn credential is — so in
  -- practice this table only ever holds a single 'pin' row)
  pin_hash TEXT,                    -- PBKDF2 hash, base64
  pin_salt TEXT,                    -- base64 random salt
  pin_fail_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,            -- set after PIN_MAX_FAILS consecutive misses, briefly blocks further guesses

  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE UNIQUE INDEX idx_auth_credentials_webauthn_id ON auth_credentials(webauthn_credential_id)
  WHERE webauthn_credential_id IS NOT NULL;

-- Active login sessions. Only the SHA-256 hash of the session token is
-- stored — the raw token lives only in the HttpOnly cookie on the device,
-- never in the database — so a leaked DB row can't be replayed as a
-- session on its own.
-- credential_id is nullable: a session started by redeeming the backup
-- code (see auth_backup_codes below) isn't tied to any one device — it's a
-- one-off recovery session used to get back into Settings and register a
-- replacement device or reset the PIN.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  session_token_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT REFERENCES auth_credentials(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL         -- sliding 7-day window, refreshed on use (see worker/src/auth.ts)
);

CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);

-- Short-lived WebAuthn ceremony state (the server-generated challenge a
-- registration/login round-trip must echo back). Single-user app, so at
-- most one register and one login ceremony is ever realistically in
-- flight at once — worker/src/auth.ts clears all rows of a given purpose
-- the moment one is consumed, rather than tracking a real TTL/expiry.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  created_at TEXT NOT NULL
);

-- A single-use recovery code for "lost every device at once." Only its
-- hash is stored. Redeeming it logs Mike in and immediately rotates to a
-- fresh code (see worker/src/auth.ts) so there's always exactly one valid
-- backup code outstanding, never zero and never a reused one.
CREATE TABLE auth_backup_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
