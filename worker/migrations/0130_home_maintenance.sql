-- Home → Maintenance (Mike, 2026-10-14). Receipts for house upkeep live in
-- ONE Drive folder "Home Maintenance", named
--   YYYY.MM.DD - System - Vendor - Service - $Amount.pdf
-- and are read from the file NAME only (no PDF reading, no AI). Recurring
-- items (septic every 4 years, chimney yearly, …) say how often a thing is
-- due; the last matching receipt sets the next due date, and a "Schedule …"
-- task lands on Today a set number of days before it.

CREATE TABLE IF NOT EXISTS home_maint_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_account_id TEXT,
  folder_id TEXT,
  folder_name TEXT,
  folder_url TEXT,
  last_scan_at TEXT,
  last_error TEXT,
  updated_at TEXT
);

-- One row per receipt (Drive file) or per hand-entered service.
CREATE TABLE IF NOT EXISTS home_maint_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'drive' CHECK (source IN ('drive', 'manual')),
  file_id TEXT UNIQUE,
  file_name TEXT,
  file_url TEXT,
  modified_at TEXT,
  service_date TEXT,            -- YYYY-MM-DD; NULL = the name couldn't be read
  system TEXT,
  vendor TEXT,
  service TEXT,
  amount REAL,
  notes TEXT,
  parse_error TEXT,             -- why the file name couldn't be read
  edited INTEGER NOT NULL DEFAULT 0, -- Mike changed the fields — a rescan leaves them alone
  missing INTEGER NOT NULL DEFAULT 0, -- the file is no longer in the folder
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_maint_records_date ON home_maint_records (service_date);

-- What needs doing on a schedule.
CREATE TABLE IF NOT EXISTS home_maint_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  match_words TEXT,             -- comma-separated words; a receipt counts when its service or vendor has one. Blank = any receipt for the system.
  interval_months INTEGER,      -- NULL = no schedule (history only)
  lead_days INTEGER NOT NULL DEFAULT 30,
  due_override TEXT,            -- "next due" typed by Mike; a newer receipt replaces it
  due_override_set TEXT,        -- day the override was typed
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One "Schedule …" task per item per due date.
CREATE TABLE IF NOT EXISTS home_maint_tasks (
  item_id TEXT NOT NULL,
  cycle_due TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, cycle_due)
);

INSERT OR IGNORE INTO home_maint_settings (id) VALUES (1);

INSERT OR IGNORE INTO home_maint_items (id, name, system, match_words, interval_months, lead_days, notes, active, position, created_at, updated_at)
VALUES ('septic-pump', 'Septic Pump-Out', 'Septic', 'pump', 48, 60, NULL, 1, 0, '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z');
