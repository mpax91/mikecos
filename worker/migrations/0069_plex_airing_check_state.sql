-- Progress state for the nightly Airing check (see plexAiring.ts's
-- runAiringCheckChunk) — same chunked/resumable shape as plex_sync_state
-- and plex_airing_scan_state, for the same underlying reason. This one
-- used to run unchunked in a single Worker invocation on the theory that
-- "check what aired in the last 3 days" was cheap regardless of library
-- size — wrong at Mike's library scale (669 shows): resolving TVMaze ids
-- for all of them cold, sequentially, in one invocation hit a D1
-- connection timeout partway through ("D1_ERROR: Network connection
-- lost"), which is exactly the silent-nightly-failure that let Ted Lasso
-- S04E09 / It's Always Sunny S18E08 go unflagged. One singleton row
-- (id = 1); the whole state is a JSON blob since its shape is internal to
-- the check and never queried in pieces.
CREATE TABLE IF NOT EXISTS plex_airing_check_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
