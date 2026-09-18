-- Server-side cache for the Today page's "Top Stories" block — the biggest
-- headlines of the moment, refreshed on a TTL (see computeTopNews in
-- src/index.ts), distinct from the News feature's own feeds/articles
-- tables. This is a single always-there row (id = 'singleton'), not one
-- row per story, because there's nothing per-story worth querying
-- independently (no read/saved state, no per-article history) — the whole
-- top-5 list is fetched, cached, and replaced together every refresh, so
-- storing it as one JSON blob avoids the churn of deleting/reinserting rows
-- every cycle for no relational benefit.
CREATE TABLE top_news_cache (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL, -- JSON array of { headline, url, source, preview, imageUrl }
  fetched_at TEXT NOT NULL
);
