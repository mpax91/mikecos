-- 0020_journal.sql picked a couple of table names that turned out to
-- collide: mikeos-db is a shared database used by other MikeOS apps too
-- (see deploy.yml's comment on the D1 backup step), and a `habits` table
-- already existed there — owned by a different app, with a different
-- schema (no `active` column). 0020's CREATE TABLE IF NOT EXISTS made that
-- collision silent instead of loud: it skipped creating this feature's
-- real `habits` table and left Journal pointed at someone else's table
-- with the wrong shape, which is what produced the "no such column:
-- active" error in production.
--
-- Fix: give every one of this feature's less-obviously-namespaced tables
-- a `journal_` prefix, so a same-named table anywhere else in this shared
-- database can never collide with these again. `journal_entries` already
-- had a safe name and had no collision (confirmed — it queried fine in
-- production before this fix), so it's untouched. The old mis-created
-- tables from 0020 (under the plain names) are left in place rather than
-- dropped — recreating/dropping tables on this D1 database has caused
-- real data loss before (see 0005_jots.sql), and these are empty either
-- way (Journal has never successfully worked in production yet), so
-- there's nothing to gain from touching them and real risk in trying.
CREATE TABLE IF NOT EXISTS journal_task_reschedules (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  from_due_date TEXT NOT NULL,
  to_due_date TEXT NOT NULL,
  rescheduled_at TEXT NOT NULL,
  rescheduled_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_task_reschedules_date ON journal_task_reschedules(rescheduled_date);
CREATE INDEX IF NOT EXISTS idx_journal_task_reschedules_entity ON journal_task_reschedules(entity_id);

CREATE TABLE IF NOT EXISTS journal_habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT,
  target_value REAL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_habit_logs (
  habit_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_journal_habit_logs_date ON journal_habit_logs(date);

CREATE TABLE IF NOT EXISTS journal_health_logs (
  date TEXT PRIMARY KEY,
  raw_data TEXT NOT NULL,
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
