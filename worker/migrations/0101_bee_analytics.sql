-- Bedford Bee: Google Analytics 4 (2026-10-10). Same Google connection as
-- Search Console (bee_gsc_account now holds both; one consent grants
-- webmasters.readonly + analytics.readonly). worker/src/bee/ga.ts.

ALTER TABLE bee_gsc_account ADD COLUMN scopes TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_property TEXT;          -- 'properties/123456789'
ALTER TABLE bee_gsc_account ADD COLUMN ga_property_name TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_properties_json TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_created TEXT;           -- property creation date (backfill start)
ALTER TABLE bee_gsc_account ADD COLUMN ga_first_date TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_last_date TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_last_sync_at TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_last_error TEXT;
ALTER TABLE bee_gsc_account ADD COLUMN ga_snapshot_json TEXT;     -- de-duplicated visitor counts for recent periods

-- Site totals per day.
CREATE TABLE bee_ga_days (
  date TEXT PRIMARY KEY,
  sessions INTEGER NOT NULL,
  users INTEGER NOT NULL,
  new_users INTEGER NOT NULL,
  views INTEGER NOT NULL,
  engaged INTEGER NOT NULL,
  engagement_sec REAL NOT NULL
);

-- Sessions by landing page × source / medium × day (social scorecard,
-- landing pages per platform, search visitors staying or leaving).
CREATE TABLE bee_ga_landing (
  date TEXT NOT NULL,
  landing TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  channel TEXT,
  sessions INTEGER NOT NULL,
  engaged INTEGER NOT NULL,
  engagement_sec REAL NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (date, landing, source, medium)
);

-- Page views by host × path × day (the website and Substack can share a property).
CREATE TABLE bee_ga_pages (
  date TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  views INTEGER NOT NULL,
  engagement_sec REAL NOT NULL,
  PRIMARY KEY (date, host, path)
);

CREATE TABLE bee_ga_geo (
  date TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY (date, city, region)
);

-- device / hour per day.
CREATE TABLE bee_ga_dims (
  date TEXT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY (date, dim, value)
);

-- Outbound link clicks (enhanced measurement) by page × link domain.
CREATE TABLE bee_ga_clicks (
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  domain TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  PRIMARY KEY (date, path, domain)
);
