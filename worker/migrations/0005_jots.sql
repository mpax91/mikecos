-- Widen entities.type to allow 'jot' — Jots are top-level, temporary-by-design
-- capture items (Keep-style), sharing the same Tiptap `content` shape as
-- notes so attachments/link-previews render identically and "turn into
-- note" is a pure type change with no content transformation needed.
-- SQLite can't ALTER a CHECK constraint in place, so recreate the table
-- (same pattern as migration 0003).

PRAGMA foreign_keys=OFF;

CREATE TABLE entities_new (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('project', 'folder', 'note', 'task', 'file', 'link', 'jot')),
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT,
  parent_id     TEXT REFERENCES entities(id) ON DELETE CASCADE,
  is_top_level  INTEGER NOT NULL DEFAULT 0,
  status        TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  last_touched  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  search_text   TEXT
);

INSERT INTO entities_new
  (id, type, title, content, parent_id, is_top_level, status, position, pinned, last_touched, created_at, updated_at, search_text)
  SELECT id, type, title, content, parent_id, is_top_level, status, position, pinned, last_touched, created_at, updated_at, search_text
  FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

CREATE INDEX IF NOT EXISTS idx_entities_parent_id ON entities(parent_id);
CREATE INDEX IF NOT EXISTS idx_entities_is_top_level ON entities(is_top_level);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(pinned);

PRAGMA foreign_keys=ON;
