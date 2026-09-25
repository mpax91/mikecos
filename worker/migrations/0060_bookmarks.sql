-- Bookmarks — a periodic, manual mirror of a Chrome bookmarks export
-- (Settings > Links > Import Bookmarks), shown as a collapsed "Bookmarks"
-- section below Quick Links on the Links page. Deliberately its own table
-- rather than reusing quick_links (a small hand-curated tray, wrong shape
-- for hundreds of nested entries) or `entities` (shared by Notes/Tasks/
-- Projects/Vault — mixing an import that fully wipes-and-rebuilds into
-- that tree would risk collateral damage). Every import fully replaces
-- whatever's here (DELETE all + bulk INSERT) — Chrome is the source of
-- truth, this is a read-only snapshot, not something edited in place.
--
-- `parent_id` is NULL for a root-level row (Chrome's own top-level
-- folders — "Bookmarks bar", "Other bookmarks", "Mobile bookmarks" — land
-- here with no synthetic wrapper folder). `url` is NULL for a folder row,
-- set for a link row. `imported_at` is the same timestamp across an
-- entire import batch, so MAX(imported_at) doubles as "last imported"
-- without a separate metadata row.
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('folder', 'link')),
  title TEXT NOT NULL,
  url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_parent ON bookmarks(parent_id, sort_order);
