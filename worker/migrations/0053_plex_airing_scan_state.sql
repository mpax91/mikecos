-- Progress state for the manually-triggered full-history Airing scan (see
-- plexAiring.ts's runFullHistoryScanChunk) — same chunked/resumable shape
-- as plex_sync_state, for the same reason: walking every synced show's
-- complete TVMaze episode list in one Worker invocation can exceed
-- Cloudflare's per-invocation subrequest cap for a large library. One
-- singleton row (id = 1); the whole state is a JSON blob since its shape
-- is internal to the scan and never queried in pieces.
CREATE TABLE IF NOT EXISTS plex_airing_scan_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
