-- Finance → Social Security (Mike, 2026-10-19). One row per "Your Social
-- Security Statement" (SSA-7005), stored whole as JSON (shape:
-- worker/src/ssa/types.ts), read from the top-level Drive folder "Social
-- Security" (worker/src/ssa/drive.ts) or imported. The repo is public: no
-- statement data ever lives in a migration, and the SSN is never stored.
CREATE TABLE IF NOT EXISTS ssa_statements (
  id TEXT PRIMARY KEY,             -- statement date YYYY-MM-DD
  statement_date TEXT NOT NULL,
  file_id TEXT,                    -- Drive file id of the PDF
  source TEXT NOT NULL DEFAULT 'pdf', -- pdf | json | import
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssa_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_account_id TEXT,
  folder_id TEXT,
  folder_name TEXT,
  folder_url TEXT,
  last_scan_at TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO ssa_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS ssa_files (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  modified_at TEXT,
  web_url TEXT,
  kind TEXT NOT NULL,               -- pdf | json | other
  statement_id TEXT,
  status TEXT NOT NULL,             -- read | imported | loaded | not_read | queued | ignored
  error TEXT,
  checked_at TEXT
);

-- Yearly reminder to download the new statement (SSA posts it each spring).
INSERT OR IGNORE INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at, realm)
VALUES ('ssa-statement', 'Download Your Social Security Statement', NULL, 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=20', '2027-04-20', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'personal');
