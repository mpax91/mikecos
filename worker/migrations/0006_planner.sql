-- Daily Planner Phase 1: give tasks a real, indexed due date instead of
-- burying it in the JSON `content` blob (TaskMeta.due_date), so "everything
-- due today or overdue, across every project" can be one fast indexed query
-- instead of parsing every task's JSON in application code.
--
-- Purely additive — ADD COLUMN, CREATE INDEX, and a data-only UPDATE to
-- backfill. No table recreation. See 0005_jots.sql for why that matters:
-- recreating `entities` (even for something as small as widening a CHECK
-- constraint) has caused real production data loss on this D1 database
-- before. Never do that again without exhaustively proving safety first.
ALTER TABLE entities ADD COLUMN due_date TEXT; -- 'YYYY-MM-DD', NULL = no due date

CREATE INDEX IF NOT EXISTS idx_entities_due_date ON entities(due_date);

-- Backfill from the existing JSON-embedded due_date so no data is lost.
-- json_extract is part of SQLite's JSON1 extension, which D1 has built in.
UPDATE entities
SET due_date = json_extract(content, '$.due_date')
WHERE type = 'task'
  AND content IS NOT NULL
  AND json_valid(content)
  AND json_extract(content, '$.due_date') IS NOT NULL;
