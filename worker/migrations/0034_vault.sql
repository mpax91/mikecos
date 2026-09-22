-- Vault: the Evernote-replacement "filing cabinet." No tags, ever —
-- categorization is entirely rule-based off which structured fields an
-- entry has filled in (see vault_categories below).
--
-- A Vault entry IS an `entities` row (type='vault_entry', is_top_level=1,
-- parent_id=NULL — same top-level pattern as Notes/Jots/Lists), not a
-- separate table. That's deliberate: it means Media/attachments, the
-- freeform note body (`content`, Tiptap JSON — for a less-structured entry
-- like a scanned Certificate of Title), pinning, and delete-cascade all
-- come for free from machinery that already exists, instead of being
-- rebuilt in parallel. Everything Vault-specific — the structured fields —
-- lives in the tables below, keyed off that same entity id.

PRAGMA foreign_keys=OFF;

CREATE TABLE entities_new (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('project', 'folder', 'note', 'task', 'file', 'link', 'vault_entry')),
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
  search_text   TEXT,
  is_jot        INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  due_time      TEXT,
  due_position  INTEGER,
  is_list       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO entities_new
  (id, type, title, content, parent_id, is_top_level, status, position, pinned, last_touched, created_at, updated_at, search_text, is_jot, due_date, due_time, due_position, is_list)
  SELECT id, type, title, content, parent_id, is_top_level, status, position, pinned, last_touched, created_at, updated_at, search_text, is_jot, due_date, due_time, due_position, is_list
  FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

CREATE INDEX IF NOT EXISTS idx_entities_parent_id ON entities(parent_id);
CREATE INDEX IF NOT EXISTS idx_entities_is_top_level ON entities(is_top_level);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(pinned);

PRAGMA foreign_keys=ON;

-- A reusable library of field *definitions* — name + type — rather than
-- one fixed universal schema. Grown over time in Settings > Vault Fields
-- as new note shapes show up, same idea as journal_habits' extensible
-- definition list.
CREATE TABLE vault_field_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'currency', 'url', 'contact', 'duration', 'list')),
  created_at TEXT NOT NULL
);

-- Named, reusable groups of fields (e.g. "Login" = URL + Username +
-- Password) — the unit templates and entries actually compose with,
-- addressing the "notes needed different info so it was inconsistent"
-- problem: build a group once, reuse it everywhere it applies.
CREATE TABLE vault_field_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE vault_group_fields (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES vault_field_groups(id) ON DELETE CASCADE,
  field_def_id TEXT NOT NULL REFERENCES vault_field_defs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_vault_group_fields_group ON vault_group_fields(group_id);

-- Named starter templates (a preset subset of the group library + starter
-- text) — created once in Settings, picked from when starting a new entry,
-- so "how should this kind of note look" only ever gets decided once.
CREATE TABLE vault_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starter_content TEXT, -- Tiptap JSON, same shape as entities.content
  created_at TEXT NOT NULL
);

CREATE TABLE vault_template_groups (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES vault_templates(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES vault_field_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_vault_template_groups_template ON vault_template_groups(template_id);

-- One row per group *instance* actually placed on a real entry (an entry
-- can carry the same group twice — e.g. two "Login" blocks for two
-- accounts — each with its own optional label override, e.g. "Primary
-- Login" vs "Backup Login").
CREATE TABLE vault_entry_groups (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES vault_field_groups(id) ON DELETE RESTRICT,
  label TEXT, -- optional override of the group's own name, for this one instance
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_vault_entry_groups_entry ON vault_entry_groups(entry_id);

-- The actual values. `value` is always stored as TEXT — for a 'list'-type
-- field (e.g. Evernote's tiered "Rewards: 3% Restaurant / 2% Streaming"
-- breakdown) it's a JSON string array, kept as one defined cell rather than
-- pushed out into freeform prose, per Mike's explicit call on that.
CREATE TABLE vault_field_values (
  id TEXT PRIMARY KEY,
  entry_group_id TEXT NOT NULL REFERENCES vault_entry_groups(id) ON DELETE CASCADE,
  field_def_id TEXT NOT NULL REFERENCES vault_field_defs(id) ON DELETE CASCADE,
  value TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_vault_field_values_entry_group ON vault_field_values(entry_group_id);

-- Auto-categorization rules: any entry with a non-empty value anywhere for
-- `trigger_field_def_id` belongs to this category — computed at read time
-- (never stored/denormalized) by the Dashboard's auto-generated
-- Inventory/Accounts/Subscriptions-style tabs. Presence of a "Serial
-- Number" value auto-derives "Inventory," no manual tagging involved.
CREATE TABLE vault_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📁',
  trigger_field_def_id TEXT NOT NULL REFERENCES vault_field_defs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_vault_categories_trigger ON vault_categories(trigger_field_def_id);
