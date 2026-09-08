-- Log of task-completion events, so "how many tasks did I finish today /
-- this week / this month / this year" can be answered without relying on
-- `entities.status`/`updated_at` — a completed task's row can later be
-- edited (retitled, re-parented) or its status flipped back to 'open',
-- either of which would silently corrupt a count derived from the live
-- entities table. This is an append-only(-ish) event log instead: one row
-- per "task went from open to done", independent of whatever happens to
-- the task afterward.
--
-- completed_date is the local calendar day (America/New_York, matching
-- every other date-bucketed view in this app — see MEETING_TZ in the
-- frontend) the completion counts toward, precomputed at insert time so
-- daily/weekly/monthly/yearly rollups are a plain GROUP BY with no
-- per-row timezone math.
--
-- Brand-new table — CREATE TABLE is safe here. See 0006_planner.sql /
-- 0005_jots.sql for why `entities` itself is never recreated on this
-- database.
CREATE TABLE task_completions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL, -- snapshot at completion time, so a later rename doesn't rewrite history
  completed_at TEXT NOT NULL, -- ISO UTC timestamp of the completion event
  completed_date TEXT NOT NULL -- 'YYYY-MM-DD', America/New_York — the day this counts toward
);

CREATE INDEX idx_task_completions_date ON task_completions(completed_date);
