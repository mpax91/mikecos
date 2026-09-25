-- Habits gets two upgrades: a direction (does less mean better — a habit
-- you're actively trying to cut down — vs more is better, e.g. water
-- intake) that comparison/streak math needs to know which way is
-- "winning", and an optional icon so the new Habits capture page has
-- something to tap that isn't just a wall of text. Both default to the
-- existing implicit behavior ('build', no icon), so this is additive —
-- nothing already logged changes meaning.
ALTER TABLE journal_habits ADD COLUMN direction TEXT NOT NULL DEFAULT 'build';
ALTER TABLE journal_habits ADD COLUMN icon TEXT;

-- Precise, timestamped occurrences — one row per tap/occurrence, not one
-- row per day. journal_habit_logs (the existing one-row-per-day total,
-- see 0020/0021) stays exactly as-is and keeps being the fast read path
-- Journal already queries; it's now a derived cache of SUM(value) over
-- this table for that (habit, date), kept in sync server-side on every
-- write (see POST/DELETE /api/habits/:id/events and the reconciling
-- logic added to POST /api/habits/:id/logs in worker/src/index.ts).
-- Keeping both means Journal's existing day-total UI needed zero
-- changes, while the new Habits capture page and Stats' trend views get
-- real timestamps to work with — time-of-day patterns, and undo of one
-- specific tap rather than only "clear the whole day".
CREATE TABLE IF NOT EXISTS journal_habit_events (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL, -- ISO instant, precise to the second
  date TEXT NOT NULL, -- local YYYY-MM-DD the tap belongs to, denormalized for range queries
  value REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_habit_events_habit_date ON journal_habit_events(habit_id, date);
CREATE INDEX IF NOT EXISTS idx_journal_habit_events_date ON journal_habit_events(date);
