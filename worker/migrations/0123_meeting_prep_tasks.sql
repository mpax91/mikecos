-- Day-of "Prep: <meeting>" tasks for recurring Work meetings (Mike,
-- 2026-10-13): one per meeting occurrence, made by the hourly cron and when
-- Today loads. The task's row has "📋 Copy Prep for Claude".
CREATE TABLE meeting_prep_tasks (
  meeting_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
