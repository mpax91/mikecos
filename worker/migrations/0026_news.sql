-- News (RSS reader). Ported in spirit from V1 MikeOS's Feedly-style reader
-- (mpax91/MikeOS) and the MikeRSS worker, rebuilt against the current
-- Entity/D1 architecture rather than V1's vanilla-JS + generic KV store.
--
-- news_feeds: one row per subscribed feed. `folder` is a plain string
-- (nullable = uncategorized) rather than its own table — V1 modeled
-- folders the same way and it's all this needs; renaming a folder is just
-- an UPDATE across every feed with that folder string.
--
-- news_articles: a SERVER-SIDE CACHE of fetched feed items, refreshed on
-- demand (subject to a per-feed TTL, see worker/src/news.ts) rather than a
-- permanent archive — old articles fall out of a feed's own RSS/Atom
-- output and stop being returned/refreshed here too. It exists as a real
-- table (not an in-memory cache like V1's RSS_CACHE) specifically so
-- read/saved state below has a stable id to key off across devices —
-- that's the whole reason this differs from V1's design.
--
-- news_read / news_saved: kept as their own tables (not columns on
-- news_articles) so saved articles can outlive their source article being
-- pruned from the cache — news_saved stores its own title/url/image
-- snapshot, same as V1's saved-articles endpoint did.
CREATE TABLE IF NOT EXISTS news_feeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  folder TEXT,
  site_url TEXT,
  favicon_url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  last_fetch_error TEXT,
  last_fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_feeds_folder ON news_feeds (folder);

CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES news_feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, -- item guid, or a hash of link+title when the feed has none
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_news_articles_feed ON news_articles (feed_id);
CREATE INDEX IF NOT EXISTS idx_news_articles_published ON news_articles (published_at DESC);

CREATE TABLE IF NOT EXISTS news_read (
  article_id TEXT PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_saved (
  id TEXT PRIMARY KEY,
  article_id TEXT, -- nullable — the source article may later fall out of the news_articles cache
  feed_title TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  description TEXT,
  saved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_saved_article ON news_saved (article_id);
