-- Journal — a daily entry that mostly writes itself. journal_entries only
-- holds the freeform "context beyond the automatic stuff" Mike types in;
-- everything auto-pulled (calendar, completed tasks, pushed tasks, notes,
-- contact quick-notes, habit values) is computed live at read time from the
-- tables that already own that data — same "D1 is the source of truth, no
-- stale caches" rule the rest of this app follows (see design-decisions.md).
-- All brand-new tables here, so plain CREATE TABLE IF NOT EXISTS is safe (see
-- 0011_task_completions.sql's comment for why that's always true for a new
-- table, and 0005_jots.sql for why recreating an *existing* one on this D1
-- database is never safe without exhaustive proof). IF NOT EXISTS on every
-- CREATE below so this migration is safely re-runnable: a first deploy
-- attempt got partway through against production (habits got created) and
-- failed before being recorded as applied, so the retry collided on
-- "table already exists" — this makes that retry (and any future one)
-- a no-op for whatever already landed, rather than a hard failure.
--
-- `date` is the local calendar day ('YYYY-MM-DD', America/New_York, same
-- convention as task_completions.completed_date and due_date) and is the
-- primary key directly — a journal entry is inherently one-per-day, so
-- there's no reason to give it a separate uuid and a UNIQUE constraint
-- instead.
CREATE TABLE IF NOT EXISTS journal_entries (
  date TEXT PRIMARY KEY, -- 'YYYY-MM-DD'
  content TEXT, -- Tiptap JSON, same shape as entities.content — freeform, optional
  search_text TEXT, -- plain-text mirror of content, same pattern as entities.search_text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Event log for task due-date changes ("pushed from today to Friday"),
-- mirroring task_completions' append-only-event-log shape and the same
-- reasoning: entities.due_date is mutable and gets overwritten in place, so
-- without a separate log there's no way to answer "what did I push today"
-- after the fact. Only written for an already-due-dated task's due_date
-- changing to a *different*, still non-null date — see the PATCH
-- /api/entities/:id handler. Scheduling a task for the first time (no
-- date -> a date) or clearing its date entirely (a date -> no date) isn't a
-- "push" in the sense Mike means and isn't logged here.
--
-- `rescheduled_date` is the local day the push itself happened on (i.e.
-- "today" at push time) — the day this row shows up in the journal for —
-- not from_due_date or to_due_date, which are kept purely as the "from X to
-- Y" detail shown on that day's entry.
CREATE TABLE IF NOT EXISTS task_reschedules (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL, -- snapshot at reschedule time, same reasoning as task_completions.title
  from_due_date TEXT NOT NULL,
  to_due_date TEXT NOT NULL,
  rescheduled_at TEXT NOT NULL, -- ISO UTC timestamp of the reschedule event
  rescheduled_date TEXT NOT NULL -- 'YYYY-MM-DD', America/New_York — the day this counts toward
);

CREATE INDEX IF NOT EXISTS idx_task_reschedules_date ON task_reschedules(rescheduled_date);
CREATE INDEX IF NOT EXISTS idx_task_reschedules_entity ON task_reschedules(entity_id);

-- Habits — quantified rather than plain done/not-done per Mike's call: a
-- habit optionally carries a target + unit ("8 glasses"), so simple
-- yes/no habits just log 1/0 with no target set, and quantified ones
-- (water, workouts, whatever comes up) don't need a schema change later.
CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT, -- e.g. 'glasses', 'minutes' — NULL for a plain done/not-done habit
  target_value REAL, -- NULL = no target, just log a number (or 1/0) per day
  active INTEGER NOT NULL DEFAULT 1, -- 0 = archived; keeps habit_logs history intact rather than deleting
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per habit per day. (habit_id, date) is the real identity — a
-- second log for the same habit/day should update the existing value, not
-- create a duplicate — so it's the primary key directly rather than a
-- separate uuid id plus a UNIQUE constraint.
CREATE TABLE IF NOT EXISTS habit_logs (
  habit_id TEXT NOT NULL,
  date TEXT NOT NULL, -- 'YYYY-MM-DD'
  value REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON habit_logs(date);

-- Health data from Mike's weekly Google Health export upload. Deliberately
-- minimal for now — `raw_data` holds the full parsed row losslessly, same
-- fallback-first approach voter_records took for the Bedford voter file
-- (see 0018_contact_import.sql) — because the export's actual field names
-- and shape aren't known yet. Once a real export is in hand, promote
-- whichever fields turn out to matter (steps, sleep, etc.) to real columns
-- the same way voter_records was always meant to grow dedicated columns
-- beyond raw_data (see design-decisions.md).
CREATE TABLE IF NOT EXISTS health_logs (
  date TEXT PRIMARY KEY, -- 'YYYY-MM-DD' — one row per day, later uploads overwrite/fill in earlier ones
  raw_data TEXT NOT NULL, -- JSON — the full parsed row for this day, whatever fields the export has
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
