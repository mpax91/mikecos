-- Recurring task definitions ("mirror recurring tasks from TickTick into
-- MikeOS"). A brand-new table, so — unlike every change to `entities` — a
-- plain CREATE TABLE is safe here; nothing about this touches the existing
-- schema or data. See 0005_jots.sql / 0006_planner.sql for why `entities`
-- itself must never be recreated.
--
-- Occurrences are materialized lazily (see GET /api/today in index.ts) —
-- there is no cron trigger. `current_task_id` tracks the single outstanding
-- spawned task for a definition; a new occurrence is only spawned once that
-- task is done/deleted (or none has been spawned yet), so a definition never
-- has two open instances at once. A missed occurrence just rolls into
-- Overdue like any other dated task, same as everything else in the planner.
CREATE TABLE IF NOT EXISTS recurring_task_definitions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT, -- entities.id of the parent project; NULL = standalone task
  rrule TEXT NOT NULL, -- full RFC5545 RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO"
  dtstart TEXT NOT NULL, -- 'YYYY-MM-DD' anchor date for the rule
  active INTEGER NOT NULL DEFAULT 1, -- 0|1
  current_task_id TEXT, -- entities.id of the live outstanding spawned task, if any
  last_spawned_due_date TEXT, -- 'YYYY-MM-DD' of the most recently spawned occurrence
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_task_definitions(active);
