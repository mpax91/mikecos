-- Finance → Credit Reports on autopilot (2026-10-16): the Drive folder
-- "Credit Reports" is found automatically and checked nightly
-- (worker/src/credit/drive.ts). One settings row + one row per file seen.
CREATE TABLE IF NOT EXISTS credit_report_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_account_id TEXT,
  folder_id TEXT,
  folder_name TEXT,
  folder_url TEXT,
  last_scan_at TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO credit_report_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS credit_report_files (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  modified_at TEXT,
  web_url TEXT,
  kind TEXT NOT NULL,            -- pdf | json | other
  report_id TEXT,                -- credit_reports.id it fed / matches
  status TEXT NOT NULL,          -- loaded | read | imported | not_read | ignored
  error TEXT,
  checked_at TEXT
);
