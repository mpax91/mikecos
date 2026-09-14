-- Contacts — a personal CRM, deliberately not built on the Entity schema:
-- a person has multi-value fields (several emails/phones) and dated fields
-- (birthday, anniversary) that don't map cleanly onto Entity's freeform
-- content, so this gets its own table. Brand-new table, so CREATE TABLE is
-- safe (see 0011_task_completions.sql for why that's always true for a new
-- table — only ALTER on an *existing* table needs care).
--
-- `circle` is a small fixed set (see CIRCLES in worker/src/index.ts),
-- matching this app's "tags stay light" convention rather than an open tag
-- system. `emails`/`phones` are JSON string arrays — trusted-shape-not-
-- enforced, same pattern shelf_items.content and canvas_items.content
-- already use. Birthday/anniversary are split into month/day/year columns
-- (year optional/nullable) rather than a single date string, so "who has a
-- birthday today" is a plain integer match with no string parsing.
--
-- `source` distinguishes how a contact entered the system — 'manual' for
-- now; 'google_import' and 'voter_file' are reserved for later importers so
-- this column doesn't need a follow-up migration when those ship.
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  title TEXT,
  circle TEXT NOT NULL DEFAULT 'other',
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  address TEXT,
  birthday_month INTEGER,
  birthday_day INTEGER,
  birthday_year INTEGER,
  anniversary_month INTEGER,
  anniversary_day INTEGER,
  anniversary_year INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_contacts_name ON contacts(name);
CREATE INDEX idx_contacts_birthday ON contacts(birthday_month, birthday_day);

-- Contact notes — the Bill-Clinton-index-card feature: quick, unstructured,
-- searchable one-liners tied to a person. Deliberately plain text, not
-- Tiptap JSON — this is meant to be a single freeform line jotted in
-- passing, not a document.
--
-- `source_type`/`source_id` make this the generic mention/link mechanism
-- the whole CRM is built on rather than a table only a "quick add" box can
-- write to: a note can come from a direct quick-add on the contact page
-- ('quick_note', source_id NULL) or, once @-mentions are wired into Notes/
-- Jots/Tasks (and later Journal), from mentioning someone there instead —
-- same table either way, so the contact's feed is just "everything that
-- ever mentioned this person," not two systems that can drift apart.
--
-- `remind_at` is the optional "check back on this" flag — set at capture
-- time, not inferred from the text (this app favors a deliberate click
-- over guessing intent from language everywhere else, and this is no
-- different). NULL means the note is just retrievable context, forever;
-- set means it should resurface as a nudge until resolved.
CREATE TABLE contact_notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'quick_note',
  source_id TEXT,
  remind_at TEXT,
  remind_resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_contact_notes_contact ON contact_notes(contact_id, created_at);
CREATE INDEX idx_contact_notes_remind ON contact_notes(remind_at);
