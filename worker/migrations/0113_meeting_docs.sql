-- Documents on a meeting (Mike, 2026-10-12): a place to keep the Google Doc
-- (or any link) a recurring meeting works from — e.g. the running doc for a
-- weekly 1:1. Stored per SERIES so every occurrence shows it:
--   series_key = 'ms-<meeting_series.id>' for meetings entered in Settings →
--   Meetings, else the Google invite's ICS UID (a one-off meeting's key is
--   its own UID, so it works there too). See seriesKeyOf() in work/router.ts.
CREATE TABLE meeting_docs (
  id TEXT PRIMARY KEY,
  series_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meeting_docs_series ON meeting_docs(series_key, position);
