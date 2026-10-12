-- Work ↔ Personal (Mike starts at Birches Health 2026-10-13).
--
-- One app, one Vault, one Projects list — every item just carries a realm
-- ('personal' | 'work'). The global All / Personal / Work switch in the top
-- bar sends X-Realm on every request and list routes filter on it.
-- Children always share their parent's realm: the trigger below copies it on
-- insert, and PATCH /api/entities/:id { realm } / move cascade it down the
-- tree in code (SQLite triggers don't recurse by default).

ALTER TABLE entities ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
-- The person a task is with / for (Contacts) — "what does Sarah have open
-- with me" before a meeting. Waiting For check-backs carry the person
-- they're waiting on.
ALTER TABLE entities ADD COLUMN contact_id TEXT;
-- Blocked tasks (Friday brief → Blocked): non-null = blocked, text = why.
ALTER TABLE entities ADD COLUMN blocked_reason TEXT;
CREATE INDEX idx_entities_realm ON entities(realm, type, status);
CREATE INDEX idx_entities_contact ON entities(contact_id);

CREATE TRIGGER entities_realm_inherit AFTER INSERT ON entities
WHEN NEW.parent_id IS NOT NULL
BEGIN
  UPDATE entities SET realm = COALESCE((SELECT realm FROM entities WHERE id = NEW.parent_id), NEW.realm) WHERE id = NEW.id;
END;

ALTER TABLE contacts ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE calendar_feeds ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE recurring_task_definitions ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE canvas_boards ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';

-- Meetings Mike enters by hand (his work calendar can't be connected).
-- rrule NULL = a one-off on start_date. Occurrences are expanded through the
-- same ICS engine as the Google feeds (a synthetic feed built from these
-- rows), so ids look like 'ms-<id>:<occurrence ISO>' (recurring) or
-- 'ms-<id>' (one-off) and meeting_notes works unchanged.
CREATE TABLE meeting_series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  realm TEXT NOT NULL DEFAULT 'work',
  start_date TEXT NOT NULL,          -- 'YYYY-MM-DD' first occurrence
  start_time TEXT,                   -- 'HH:MM' (America/New_York); NULL = all day
  duration_min INTEGER NOT NULL DEFAULT 30,
  rrule TEXT,                        -- bare RRULE, e.g. 'FREQ=WEEKLY;BYDAY=TU'
  until_date TEXT,                   -- 'YYYY-MM-DD' last day, inclusive
  skip_dates TEXT NOT NULL DEFAULT '[]', -- JSON 'YYYY-MM-DD'[] (cancelled occurrences)
  location TEXT,
  link TEXT,                         -- Meet/Zoom link
  project_id TEXT,                   -- tasks from its notes land here
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meeting_series_people (
  series_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, contact_id)
);
CREATE INDEX idx_msp_contact ON meeting_series_people(contact_id);

-- A pasted/uploaded meeting summary (Gemini "Notes by Gemini", or any text).
-- The full text also becomes a note entity (searchable, in Notes).
CREATE TABLE meeting_summaries (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  series_key TEXT NOT NULL,          -- 'ms-<id>' or the ICS UID
  occurrence_start TEXT NOT NULL,    -- ISO instant
  meeting_title TEXT NOT NULL,
  realm TEXT NOT NULL DEFAULT 'work',
  note_entity_id TEXT,
  summary TEXT,                      -- the Summary section, plain text
  details TEXT,                      -- the Details section, plain text
  decisions TEXT,
  raw_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gemini',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_msum_series ON meeting_summaries(series_key, occurrence_start);
CREATE INDEX idx_msum_meeting ON meeting_summaries(meeting_id);

-- Next steps found in a summary. Mike decides each one: a task for him, a
-- Waiting item on someone else, or dismissed.
CREATE TABLE meeting_actions (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  text TEXT NOT NULL,
  owner_name TEXT,
  contact_id TEXT,
  is_mine INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | task | waiting | dismissed
  entity_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mact_summary ON meeting_actions(summary_id);
CREATE INDEX idx_mact_contact ON meeting_actions(contact_id);

-- Friday's Start / Stop / Continue + highlights, one row per week per realm.
CREATE TABLE week_reviews (
  week_start TEXT NOT NULL,          -- Monday 'YYYY-MM-DD'
  realm TEXT NOT NULL,               -- 'work' | 'personal' | 'all'
  start_text TEXT NOT NULL DEFAULT '',
  stop_text TEXT NOT NULL DEFAULT '',
  continue_text TEXT NOT NULL DEFAULT '',
  highlights TEXT NOT NULL DEFAULT '',
  priorities TEXT NOT NULL DEFAULT '', -- Monday: Mike's own top priorities
  updated_at TEXT NOT NULL,
  PRIMARY KEY (week_start, realm)
);

-- Small key/value settings for the work features (e.g. 'my_names' — how
-- Mike's name appears in meeting notes, so "Mike Palladino will…" is his).
CREATE TABLE work_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO work_settings (key, value) VALUES ('my_names', 'Mike Palladino, Michael Palladino, Mike, Michael');
