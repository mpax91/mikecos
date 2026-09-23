-- Vault Passwords — a LastPass/Bitwarden-style credential card, living as a
-- new "Passwords" section on a Vault entry (below Notes, above Links, per
-- Mike's explicit placement), between the entry's Notes and Links sections.
--
-- Same trick as is_jot (0005) and is_list (0029): NOT a new entities.type
-- value. A password is stored as an ordinary type='note' child entity with
-- this flag set, specifically to avoid ever touching entities' CHECK (type
-- IN (...)) constraint again — the 0034 migration's table-recreation-to-
-- change-a-CHECK-constraint approach silently lost 75 rows on remote D1
-- once (see 0035_restore_lost_entities.sql), and every migration since has
-- stuck to pure ALTER TABLE ADD COLUMN on entities as a result.
--
-- entities.title is the card's "Name" (e.g. "google.com"); the
-- credential-specific fields (url/username/password) don't belong crammed
-- onto the shared entities table, so they live in this dedicated 1:1
-- side table instead — same reasoning as vault_facts being its own table
-- rather than more entities columns.
ALTER TABLE entities ADD COLUMN is_password INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_entities_is_password ON entities(is_password) WHERE is_password = 1;

CREATE TABLE IF NOT EXISTS vault_credentials (
  entity_id  TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  url        TEXT,
  username   TEXT,
  password   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
