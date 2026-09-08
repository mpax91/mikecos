-- Self-service Google Calendar feeds for the Settings screen's Calendar
-- Integrations panel. Previously the two ICS "secret address" URLs lived
-- only as GitHub Actions / Cloudflare Worker secrets, which meant Mike
-- couldn't add, remove, or fix one without editing GitHub repo secrets and
-- redeploying — and that path turned out to be fragile in practice. Moving
-- the URL into the app's own database trades a bit of secrecy (it now sits
-- in the same D1 database as everything else, rather than a dedicated
-- secrets store) for it actually being usable day to day; Mike has weighed
-- that and prefers self-service. A brand-new table, so — as with every
-- other migration here — a plain CREATE TABLE is safe; nothing about this
-- touches `entities`.
CREATE TABLE IF NOT EXISTS calendar_feeds (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
