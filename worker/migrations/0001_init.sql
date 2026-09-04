-- MikeOS core data model: single flexible entity table + links table.
-- Every future module (Today, Inbox, CRM, RSS...) is a new `type` value here,
-- not a new table.

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('project', 'folder', 'note', 'task')),
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT,                 -- Tiptap JSON (stringified) for notes; null otherwise
  parent_id     TEXT REFERENCES entities(id) ON DELETE CASCADE,
  is_top_level  INTEGER NOT NULL DEFAULT 0,   -- 1 only for Projects
  status        TEXT,                 -- tasks: 'open' | 'done'; projects: 'active' | 'archived'
  position      INTEGER NOT NULL DEFAULT 0,
  last_touched  TEXT,                 -- ISO timestamp, updated on real content/status edits only
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_parent_id ON entities(parent_id);
CREATE INDEX IF NOT EXISTS idx_entities_is_top_level ON entities(is_top_level);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS links (
  id            TEXT PRIMARY KEY,
  from_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id         TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  link_type     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_links_from_id ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to_id ON links(to_id);
