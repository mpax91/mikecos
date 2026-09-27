-- news_folders: lets Mike control the order News' sidebar groups its
-- folders in (Settings → News Feeds → "Folder Order"), instead of the
-- fixed alphabetical order /api/news/feeds used to sort by.
--
-- Keyed by the folder name string itself, same modeling choice 0026_news.sql
-- made for news_feeds.folder — folders aren't their own entity anywhere
-- else, so there's nothing to foreign-key against. A row here is created
-- lazily, only the first time Mike actually reorders (see
-- PUT /api/news/folders/reorder) — a folder with no row yet just falls
-- back to sorting alphabetically after every folder that DOES have one,
-- so adopting this feature is opt-in and never breaks an existing setup.
-- Renaming a folder (via a feed's own folder field) intentionally does NOT
-- carry its old position onto the new name — it starts over at the back
-- of the ordered list, same as a folder nobody's ordered yet. An orphaned
-- row (every feed that used to be in this folder got moved or deleted) is
-- harmless: it just never matches a folder name in use, so it never
-- affects rendering, and naturally goes away if the name is ever reused.
CREATE TABLE IF NOT EXISTS news_folders (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
