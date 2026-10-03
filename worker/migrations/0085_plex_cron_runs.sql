-- Visibility into whether the nightly Plex sync / Airing check crons are
-- actually firing and succeeding on their own — added after fixing the
-- authGate 401 that was silently breaking them every night (see
-- 0084_bet_options_tipper_line.sql's neighbor commit, CRON_INTERNAL_SECRET
-- in types.ts) and then finding the automatic check STILL hadn't picked
-- up new episodes the very next morning. Without this, diagnosing "did
-- the cron actually run, and if so what happened" required either
-- Cloudflare dashboard/CLI access (which the deploy pipeline has but no
-- one debugging from chat does) or waiting another night and guessing.
-- One row per scheduled() invocation of PLEX_SYNC_CRON or
-- PLEX_AIRING_CRON — written at the end of that branch whether it
-- succeeded or threw, so a gap in this table (not just an 'error' row)
-- is itself informative: it means `scheduled()` never ran at all that
-- tick, which is a Cloudflare-side Cron Trigger problem, not an
-- application bug.
CREATE TABLE IF NOT EXISTS plex_cron_runs (
  id TEXT PRIMARY KEY,
  cron_name TEXT NOT NULL,      -- 'plex_sync' | 'plex_airing_check'
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL,        -- 'success' | 'error'
  chunks_run INTEGER NOT NULL,
  detail TEXT                   -- JSON summary on success, error message on failure
);

CREATE INDEX IF NOT EXISTS idx_plex_cron_runs_name_started ON plex_cron_runs(cron_name, started_at DESC);
