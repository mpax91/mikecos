-- Shows Mike never wants Airing reminders for (Saturday Night Live, Cops…).
-- Ignored from the Airing row's ⋯ menu, managed in Settings → Ignored
-- Shows. Matched by the Plex show id OR its TheTVDB id, so a re-match in
-- Plex (new rating key, same show) stays ignored. The nightly check and
-- the full-history scan skip these shows entirely (no TVMaze calls, no
-- missing-episode rows, no "Download …" tasks). See plexAiring.ts.
CREATE TABLE IF NOT EXISTS plex_ignored_shows (
  show_item_id TEXT PRIMARY KEY,
  tvdb_id TEXT,
  title TEXT NOT NULL,
  ignored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plex_ignored_shows_tvdb ON plex_ignored_shows(tvdb_id);

-- Seed Mike's first two.
INSERT OR IGNORE INTO plex_ignored_shows (show_item_id, tvdb_id, title, ignored_at)
SELECT id, tvdb_id, title, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM plex_items
WHERE type = 'show' AND lower(trim(title)) IN ('saturday night live', 'cops');

-- Clear what they've already put in Airing: their open "Download …" tasks
-- and their outstanding (not dismissed) missing-episode rows.
DELETE FROM entities
WHERE type = 'task' AND status = 'open' AND id IN (
  SELECT m.task_id FROM plex_missing_episodes m
  JOIN plex_ignored_shows i ON i.show_item_id = m.show_item_id
  WHERE m.dismissed = 0 AND m.task_id IS NOT NULL
);
DELETE FROM plex_missing_episodes
WHERE dismissed = 0 AND show_item_id IN (SELECT show_item_id FROM plex_ignored_shows);
