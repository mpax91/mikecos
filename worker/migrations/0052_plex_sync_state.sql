-- Progress state for the chunked/resumable Plex sync (see plexSync.ts's
-- header comment for why it's chunked at all — Cloudflare's per-
-- invocation subrequest cap). One singleton row (id = 1); the whole
-- state is kept as a JSON blob since its shape is internal to the sync
-- and doesn't need to be queried in pieces.
CREATE TABLE IF NOT EXISTS plex_sync_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
