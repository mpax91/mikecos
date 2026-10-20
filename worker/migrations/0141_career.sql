-- Finance → Career (Mike, 2026-10-20): a career earnings tracker built from
-- the paystubs and equity documents Mike keeps in one Drive folder per
-- employer (folders stay where they are — copies of the same folder are
-- merged by file name). Paystubs and equity events are stored whole as JSON
-- (shapes: worker/src/career/types.ts). History is imported once (read by
-- Claude); new files in any employer folder are picked up nightly, and the
-- current employer's paystubs are read by a rule-based reader
-- (worker/src/career/pdf.ts). The repo is public: no pay data, employer
-- list or file ids ever live in a migration, and SSNs are never stored.

CREATE TABLE IF NOT EXISTS career_employers (
  id TEXT PRIMARY KEY,               -- slug, e.g. 'teachable'
  name TEXT NOT NULL,                -- display name
  aliases TEXT NOT NULL DEFAULT '[]',-- JSON string[]: other names (a rebrand, the legal name on the stub)
  folder_names TEXT NOT NULL DEFAULT '[]', -- JSON string[]: Drive folder names to read (default [name])
  title TEXT,                        -- Mike's role(s), free text
  start_date TEXT,                   -- YYYY-MM-DD override (else first paystub)
  end_date TEXT,                     -- YYYY-MM-DD override (else last paystub; NULL + current = still there)
  is_current INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  salaries TEXT NOT NULL DEFAULT '[]', -- JSON [{date, annual, source}] from offer / raise letters
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS career_stubs (
  id TEXT PRIMARY KEY,               -- <employer>:<pay date>:<kind>[:n]
  employer_id TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  kind TEXT NOT NULL,                -- regular | bonus | stipend | severance | equity | other
  file_id TEXT,
  source TEXT NOT NULL DEFAULT 'pdf',-- pdf | import | json
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_career_stubs_employer ON career_stubs (employer_id, pay_date);

CREATE TABLE IF NOT EXISTS career_events (
  id TEXT PRIMARY KEY,               -- <employer>:<date>:<kind>[:n]
  employer_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,                -- see CareerEventKind
  file_id TEXT,
  source TEXT NOT NULL DEFAULT 'import',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS career_folders (
  folder_id TEXT PRIMARY KEY,
  employer_id TEXT NOT NULL,
  cloud_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  listed_at TEXT
);

CREATE TABLE IF NOT EXISTS career_files (
  file_id TEXT PRIMARY KEY,
  employer_id TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  modified_at TEXT,
  web_url TEXT,
  kind TEXT NOT NULL,                -- pdf | json | other
  record_id TEXT,                    -- stub or event id it became
  status TEXT NOT NULL,              -- read | imported | loaded | duplicate | not_read | queued | ignored
  error TEXT,
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS career_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO career_settings (id) VALUES (1);
