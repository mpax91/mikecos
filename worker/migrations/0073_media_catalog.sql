-- Hand-entered catalog of media Plex doesn't (and never will) know about —
-- physical books and ebooks/audiobooks bought outside Plex. Deliberately
-- separate from plex_items rather than merged into it: plex_items is a
-- mirror of what a Plex sync actually reports, and letting hand-entered
-- rows live in that same table risks them getting silently clobbered or
-- orphaned by a future re-sync. This is purely a catalog — "I own this,
-- here's the format" — no read/listened status, no due dates; see the
-- Media section's own design discussion for why that's a deliberate cut.
CREATE TABLE IF NOT EXISTS media_items (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  author     TEXT,
  format     TEXT NOT NULL CHECK (format IN ('physical_book', 'ebook', 'audiobook')),
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(title);
