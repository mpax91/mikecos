-- Bedford Bee: Bing Webmaster Tools + Microsoft Clarity (2026-10-11).
-- Both authenticate with a pasted key (no sign-in flow), stored encrypted
-- with CLOUD_ACCOUNT_ENC_KEY. worker/src/bee/bing.ts, bee/clarity.ts.

CREATE TABLE bee_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bing_key_enc TEXT,
  bing_site TEXT,                -- verified site URL in Bing
  bing_sites_json TEXT,
  bing_last_sync_at TEXT,
  bing_last_error TEXT,
  clarity_token_enc TEXT,
  clarity_last_sync_at TEXT,
  clarity_last_error TEXT,
  updated_at TEXT
);
INSERT INTO bee_keys (id) VALUES (1);

-- Bing reports searches and pages in weekly buckets (week = the bucket's date).
CREATE TABLE bee_bing_queries (
  week TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  click_pos REAL,
  impr_pos REAL,
  PRIMARY KEY (week, query)
);
CREATE TABLE bee_bing_pages (
  week TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  click_pos REAL,
  impr_pos REAL,
  PRIMARY KEY (week, page)
);
-- Site totals per day (GetRankAndTrafficStats).
CREATE TABLE bee_bing_days (
  date TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL
);
-- Crawl / index issues as of the last sync.
CREATE TABLE bee_bing_issues (
  url TEXT PRIMARY KEY,
  issue TEXT,
  http_code INTEGER,
  seen_at TEXT
);

-- Clarity's API only returns the last 1–3 days (10 calls/day), so MikeOS
-- keeps one snapshot per day per view: '' (site), 'url', 'source', 'device'.
CREATE TABLE bee_clarity_days (
  date TEXT NOT NULL,            -- the UTC day the 24h snapshot covers (yesterday at sync time)
  view TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, view)
);
