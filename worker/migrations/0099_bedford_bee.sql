-- Bedford Bee dashboard (2026-10-10). Substack has no API: Mike drops three
-- all-time exports into a Drive folder ("Bedford Bee") each month — posts
-- (email stats), subscribers, and Stripe balance history — and MikeOS reads
-- them (worker/src/bee/). Brand-new tables, so plain CREATE TABLE.

-- One row: which Drive folder holds the exports (auto-found by name).
CREATE TABLE bee_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_account_id TEXT,
  folder_id TEXT,
  folder_name TEXT,
  folder_url TEXT,
  last_scan_at TEXT,
  last_error TEXT,
  updated_at TEXT
);
INSERT INTO bee_settings (id) VALUES (1);

-- Every file seen in the folder. kind: posts | subscribers | stripe | other.
-- export_date = the day Mike exported (from the file name, else Drive's
-- modified date) — it orders subscriber snapshots.
CREATE TABLE bee_files (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  export_date TEXT,
  modified_at TEXT,
  web_url TEXT,
  status TEXT NOT NULL,          -- parsed | skipped | failed
  error TEXT,
  row_count INTEGER,
  parsed_at TEXT
);

-- Posts: one row per post, keyed by its publish timestamp (the export has
-- no post id; titles get edited). The newest posts export wins.
CREATE TABLE bee_posts (
  post_date TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  audience TEXT,
  sent INTEGER, delivered INTEGER, dropped INTEGER,
  opens INTEGER, opened INTEGER, open_rate REAL,
  opens_day7 INTEGER, opens_day28 INTEGER,
  clicks INTEGER, clicked INTEGER,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, restacks INTEGER,
  signups INTEGER, subscribes INTEGER, upgrades INTEGER, unsubscribes INTEGER, complaints INTEGER,
  raw_json TEXT,
  file_id TEXT,
  updated_at TEXT NOT NULL
);

-- Subscribers as of the newest export, plus anyone who has since left
-- (active = 0, left_date set). contact_id links the MikeOS contact
-- (automatic "Bee" label while active).
CREATE TABLE bee_subscribers (
  email TEXT PRIMARY KEY,        -- lowercased
  name TEXT,
  type TEXT,                     -- Free | Yearly Subscriber | Founding member | Monthly … | Author
  start_date TEXT,
  first_paid_date TEXT,
  cancel_date TEXT,
  expiration_date TEXT,
  stripe_plan TEXT,
  revenue REAL,
  source_free TEXT,
  source_paid TEXT,
  state TEXT,
  country TEXT,
  stats_json TEXT,               -- latest engagement numbers from the export
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_export TEXT,
  last_seen_export TEXT,
  left_date TEXT,
  contact_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bee_subscribers_contact ON bee_subscribers(contact_id);

-- One row per subscriber per export — the history behind losses,
-- upgrades and engagement trends (each export only knows "today").
CREATE TABLE bee_subscriber_snapshots (
  export_date TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT,
  row_json TEXT,                 -- the subscriber's whole export row
  file_id TEXT,
  PRIMARY KEY (export_date, email)
);

-- Stripe balance history (charges, fees, payouts, refunds …), by txn id.
CREATE TABLE bee_stripe_txns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT,
  amount REAL NOT NULL,
  fee REAL NOT NULL,
  net REAL NOT NULL,
  currency TEXT,
  created TEXT NOT NULL,         -- 'YYYY-MM-DD HH:MM' UTC as exported
  available_on TEXT,
  description TEXT,
  transfer TEXT,
  transfer_date TEXT,
  file_id TEXT
);

-- Monthly "Export Bedford Bee Stats" reminder (Mike, 2026-10-10): an
-- ordinary recurring task (editable in Settings → Recurring Tasks) on the
-- 1st; MikeOS checks it off once all three new exports land in the folder.
INSERT INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at)
VALUES ('bee-export', 'Export Bedford Bee Stats (Posts, Subscribers, Stripe)', NULL, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-11-01', 1, NULL, NULL, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');
