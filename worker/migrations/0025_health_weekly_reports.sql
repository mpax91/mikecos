-- Health dashboard: one row per Google Health weekly-report email Mike
-- uploads through Settings. Keyed by week_start so re-uploading a week
-- (duplicate/overlapping exports are common — he uploads batches that
-- overlap on purpose) upserts in place rather than duplicating the row.
--
-- Deltas ("N more steps than last week") are deliberately NOT stored here
-- — Google's own delta text goes wrong whenever the prior week had missing
-- data (e.g. comparing against a week the tracker wasn't worn). The
-- dashboard/journal/stats surfaces compute deltas themselves from the
-- absolute values in consecutive rows.
--
-- Several metrics are nullable because the wearable wasn't always worn —
-- see the parser (worker/src/health.ts) for exactly when a 0 becomes a
-- stored null vs. a real zero: heart rate, sleep, and active-zone-minutes
-- can't legitimately be zero for a whole week, so a reading of exactly 0
-- for those is treated as "no data"; miles and floors are stored as-is
-- since a real zero is plausible for those and can't be told apart from
-- missing data.
CREATE TABLE IF NOT EXISTS health_weekly_reports (
  week_start TEXT PRIMARY KEY, -- YYYY-MM-DD, the Sunday the report week starts
  week_end TEXT NOT NULL,      -- YYYY-MM-DD, the Saturday the report week ends
  total_steps INTEGER,
  avg_steps_per_day INTEGER,
  best_day_steps INTEGER,
  best_day_weekday TEXT,       -- 'Sun'..'Sat', from the "Best day!" ring position
  total_floors INTEGER,
  total_miles REAL,
  avg_calories_burned INTEGER,
  avg_active_zone_minutes INTEGER, -- nullable — see comment above
  avg_restful_sleep_minutes INTEGER, -- nullable — stored as minutes; source format is "Xh Ym"
  avg_hours_with_250_steps REAL, -- nullable — source format is "N of 9h"; denominator constant at 9 across every sample seen
  avg_resting_heart_rate INTEGER, -- nullable
  avg_weight_lb REAL,          -- NOTE: Google Health appears to carry forward the last real scale reading on weeks with no new weigh-in — see parser/dashboard comments for the "flat run" caveat
  raw_text TEXT NOT NULL,      -- the full extracted PDF text, kept for re-parsing if the parser improves later
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_weekly_reports_week_end ON health_weekly_reports (week_end);
