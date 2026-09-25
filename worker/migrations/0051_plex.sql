-- Plex library mirror — a read-only synced copy of Mike's Plex Media
-- Server catalogue, so MikeOS can browse/search/flag it without hitting
-- Plex on every click (same "sync once, query the local copy" shape as
-- the voter file and health imports). Its own table family, off the
-- `entities` world entirely, same reasoning as Wallet/Rewards/Payment
-- Cards: a media catalogue has nothing to do with personal tasks/notes,
-- so it gets its own id space rather than being shoehorned into one.
--
-- plex_items is deliberately one flat table for every level of the
-- catalogue (movie, show, season, episode, artist, album, track, or a
-- flat "item" for anything else — podcasts/audiobooks/comedy collections
-- included, however Mike's Plex version happens to categorize them) with
-- a self-referencing parent_id, rather than a table per media type — the
-- shapes overlap enough (title, year, guid, artwork, a file path) that
-- splitting them would mean four near-identical tables and four near-
-- identical sync code paths for no real benefit. `type` is the
-- discriminator the UI/queries branch on.

CREATE TABLE IF NOT EXISTS plex_libraries (
  id           TEXT PRIMARY KEY,   -- Plex's librarySectionID, as a string
  title        TEXT NOT NULL,      -- whatever Mike named the section in Plex
  library_type TEXT NOT NULL,      -- Plex's own section type: movie | show | artist | photo | other
  item_count   INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT
);

CREATE TABLE IF NOT EXISTS plex_items (
  id                  TEXT PRIMARY KEY,   -- Plex ratingKey, as a string
  library_id          TEXT NOT NULL REFERENCES plex_libraries(id),
  parent_id           TEXT REFERENCES plex_items(id),  -- season's show, episode's season, album's artist, track's album
  type                TEXT NOT NULL,      -- movie | show | season | episode | artist | album | track | item
  title                TEXT NOT NULL,
  sort_title          TEXT,
  year                INTEGER,
  season_number       INTEGER,   -- episodes/seasons only
  episode_number       INTEGER,   -- episodes only
  guid                TEXT,      -- Plex's own matched-metadata guid, e.g. "plex://episode/…" or "local://…" when unmatched
  tvdb_id             TEXT,      -- parsed out of Plex's Guid array, shows only — what ties this show to TVMaze (see plexAiring.ts)
  summary             TEXT,
  genres              TEXT,      -- comma-joined; Plex returns a tag array, flattened for simple LIKE filtering
  studio              TEXT,
  thumb_key            TEXT,      -- Plex's own /library/metadata/…/thumb path, proxied through the Worker on demand — never re-hosted
  file_path            TEXT,      -- server-side path from Media/Part — shown for context so Mike can go fix the real file; MikeOS never touches it
  duration_ms          INTEGER,
  added_at             TEXT,      -- Plex's addedAt
  plex_updated_at      TEXT,      -- Plex's own updatedAt, so a re-sync can tell what actually changed
  synced_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plex_items_library ON plex_items(library_id);
CREATE INDEX IF NOT EXISTS idx_plex_items_parent ON plex_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_plex_items_type ON plex_items(type);
CREATE INDEX IF NOT EXISTS idx_plex_items_tvdb ON plex_items(tvdb_id);

-- Caches each show's resolved TVMaze show id (or a confirmed "no match"),
-- so the nightly airing check isn't re-resolving the same show against
-- TVMaze every single night — only once, plus whenever a show's tvdb_id
-- changes (a re-match in Plex) or the cached lookup is cleared.
CREATE TABLE IF NOT EXISTS plex_tvmaze_shows (
  show_item_id  TEXT PRIMARY KEY REFERENCES plex_items(id),
  tvdb_id       TEXT NOT NULL,
  tvmaze_id     INTEGER,       -- null means "looked up, TVMaze has no match" — still cached, so it isn't retried nightly
  resolved_at   TEXT NOT NULL
);

-- An episode TVMaze says aired, that isn't (yet) in the synced Plex
-- library for that show — the whole point of Part 4 of this feature. A
-- row disappears once the next library sync finds the matching episode
-- (see plexAiring.ts's reconciliation), or Mike explicitly dismisses one
-- he doesn't actually want (a special/clip-show episode, say).
CREATE TABLE IF NOT EXISTS plex_missing_episodes (
  id             TEXT PRIMARY KEY,
  show_item_id   TEXT NOT NULL REFERENCES plex_items(id),
  show_title     TEXT NOT NULL,  -- denormalized so the briefing/list can render without a join
  season_number  INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  episode_name   TEXT,
  aired_on       TEXT NOT NULL,  -- YYYY-MM-DD, from TVMaze
  detected_at    TEXT NOT NULL,
  dismissed      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(show_item_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_plex_missing_episodes_open ON plex_missing_episodes(dismissed, aired_on);
