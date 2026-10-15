-- Throwback Thursday (Mike, 2026-10-14): rank older Bee stories as reshare
-- candidates and remember what's been reused (worker/src/bee/throwback.ts).
-- Reshares are mostly DETECTED from the posts themselves ("🕰️THROWBACK
-- THURSDAY: …" prefix, or the same headline 30+ days later); this table only
-- holds what Mike tells MikeOS by hand. Stories are keyed by their anchor
-- part (Facebook post id when there is one: 'fb:<id>').
CREATE TABLE bee_throwback_marks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'planned', 'never', 'not_reshare')),
  orig_anchor TEXT,          -- manual / planned / never: the original story
  reuse_anchor TEXT,         -- not_reshare: the post wrongly detected as a reshare
  used_on TEXT,              -- manual: day it ran again; planned: the Thursday it's picked for
  headline TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bee_throwback_marks_orig ON bee_throwback_marks(orig_anchor);

CREATE TABLE bee_throwback_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_days INTEGER NOT NULL DEFAULT 14,     -- This Time Last Year: ± days around the date
  cooldown_days INTEGER NOT NULL DEFAULT 365,  -- a reshared story sits out this long
  min_age_days INTEGER NOT NULL DEFAULT 180,   -- Best Of: only stories at least this old
  updated_at TEXT
);
INSERT INTO bee_throwback_settings (id) VALUES (1);

-- Saturday task (Mike schedules the week's posts on Saturdays).
INSERT OR IGNORE INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at, realm)
VALUES ('bee-throwback', 'Pick This Week''s Throwback', NULL, 'FREQ=WEEKLY;BYDAY=SA', '2026-10-17', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'personal');
