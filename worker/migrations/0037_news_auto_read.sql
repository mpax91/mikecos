-- Auto-mark-as-read for News: articles older than a configurable age
-- silently clear out of the unread feed on their own, so it doesn't pile
-- up into an unmanageable backlog if Mike doesn't check News for a few
-- days. One-row settings table (id fixed to 'default') rather than a
-- generic app_settings table, since nothing else needs one yet — see
-- news.md / 0026_news.sql for the rest of the News schema.
--
-- news_read.auto_marked distinguishes an auto-clear from a real,
-- intentional mark-read: without it, a nightly sweep would flood the
-- "Recently Read" fail-safe view (0029-era feature — see NewsPage.tsx)
-- with articles Mike never actually looked at, defeating its whole
-- purpose as an undo list for accidental swipes. Recently Read only ever
-- shows auto_marked = 0 rows.
--
-- Brand-new table plus an additive column, so plain CREATE TABLE /
-- ALTER TABLE ADD COLUMN is safe (see 0011_task_completions.sql).
CREATE TABLE IF NOT EXISTS news_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  auto_read_hours INTEGER, -- NULL = disabled; default seeded at 48h below
  updated_at TEXT NOT NULL
);

INSERT INTO news_settings (id, auto_read_hours, updated_at)
VALUES ('default', 48, datetime('now'))
ON CONFLICT (id) DO NOTHING;

ALTER TABLE news_read ADD COLUMN auto_marked INTEGER NOT NULL DEFAULT 0;
