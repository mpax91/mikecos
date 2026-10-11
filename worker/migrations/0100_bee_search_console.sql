-- Bedford Bee: Google Search Console (2026-10-10). Read-only API access
-- (webmasters.readonly) for the Bee's Google account, through the same
-- "MikeOS" Google OAuth app as Drive. GSC keeps only 16 months, so MikeOS
-- keeps every day it pulls, forever (worker/src/bee/gsc.ts).

CREATE TABLE bee_gsc_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  site_url TEXT,                 -- 'sc-domain:thebedfordbee.com' or 'https://thebedfordbee.com/'
  sites_json TEXT,               -- every property the account can see
  status TEXT,                   -- connected | error
  last_sync_at TEXT,
  last_error TEXT,
  first_date TEXT,               -- earliest day stored
  last_date TEXT,                -- latest finalized day stored
  connected_at TEXT
);

-- Site totals per day (include anonymized queries the query rows don't).
CREATE TABLE bee_gsc_days (
  date TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  position REAL
);

-- Query × page × day — the detail behind every SEO rule.
CREATE TABLE bee_gsc_rows (
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  position REAL,
  PRIMARY KEY (date, query, page)
);
CREATE INDEX idx_bee_gsc_rows_query ON bee_gsc_rows(query);
CREATE INDEX idx_bee_gsc_rows_page ON bee_gsc_rows(page);

-- Page totals per day (include anonymized queries).
CREATE TABLE bee_gsc_pages (
  date TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  position REAL,
  PRIMARY KEY (date, page)
);

-- Device / country per day.
CREATE TABLE bee_gsc_dims (
  date TEXT NOT NULL,
  dim TEXT NOT NULL,             -- device | country
  value TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  PRIMARY KEY (date, dim, value)
);

-- Indexing watch: Google's URL Inspection verdict for recent pages
-- (from the site's sitemaps).
CREATE TABLE bee_gsc_index (
  url TEXT PRIMARY KEY,
  lastmod TEXT,
  verdict TEXT,                  -- PASS | NEUTRAL | FAIL | …
  coverage TEXT,                 -- e.g. "Submitted and indexed", "Discovered - currently not indexed"
  last_crawl TEXT,
  checked_at TEXT
);
