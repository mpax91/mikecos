-- Statements: rule-based (no AI) reading of statement PDFs from per-account
-- Drive folders. See worker/src/statements/*. One row per registered Drive
-- folder; each folder is read by exactly one template (template_id).
CREATE TABLE IF NOT EXISTS statement_folders (
  id TEXT PRIMARY KEY,
  cloud_account_id TEXT NOT NULL,          -- cloud_accounts.id (a Google Drive account)
  folder_id TEXT NOT NULL,                 -- Drive folder id
  folder_name TEXT NOT NULL,
  folder_url TEXT,
  template_id TEXT,                        -- e.g. 'ny529'; NULL while Needs Template
  status TEXT NOT NULL DEFAULT 'needs_template', -- live | needs_template | ignored
  owner TEXT NOT NULL DEFAULT 'household', -- household | chase
  vault_entry_id TEXT,                     -- the auto-created per-account Vault note
  settings_json TEXT,                      -- per-template settings (e.g. NY 529 limit, projection return)
  meta_json TEXT,                          -- engine bookkeeping (reminder task ids, change history)
  last_scan_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (cloud_account_id, folder_id)
);

-- Every PDF seen in a registered folder, and what happened when it was read.
CREATE TABLE IF NOT EXISTS statement_files (
  id TEXT PRIMARY KEY,
  folder_row_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  web_url TEXT,
  modified_at TEXT,
  status TEXT NOT NULL,                    -- parsed | unreadable | failed | duplicate
  error TEXT,
  statement_id TEXT,
  parsed_at TEXT NOT NULL,
  UNIQUE (folder_row_id, file_id)
);

-- One normalized row per statement period.
CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  folder_row_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  period_start TEXT NOT NULL,              -- YYYY-MM-DD
  period_end TEXT NOT NULL,                -- YYYY-MM-DD
  values_json TEXT NOT NULL,               -- template-defined fields
  checks_json TEXT NOT NULL,               -- in-statement math checks
  created_at TEXT NOT NULL,
  UNIQUE (folder_row_id, period_end)
);
CREATE INDEX IF NOT EXISTS idx_statements_folder ON statements (folder_row_id, period_end);

CREATE TABLE IF NOT EXISTS statement_transactions (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  folder_row_id TEXT NOT NULL,
  txn_date TEXT NOT NULL,                  -- YYYY-MM-DD
  description TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- aip | contribution | withdrawal | other
  amount REAL NOT NULL,
  units REAL,
  unit_price REAL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_statement_txns_folder ON statement_transactions (folder_row_id, txn_date);

-- Things worth Mike's attention. Recomputed on every scan: a flag whose
-- condition clears is resolved automatically; a dismissed one stays quiet.
CREATE TABLE IF NOT EXISTS statement_flags (
  id TEXT PRIMARY KEY,
  folder_row_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL,                  -- warn | info
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  dismissed_at TEXT,
  UNIQUE (folder_row_id, dedupe_key)
);

-- Vault facts written by Statements carry a key so they can be updated in
-- place; Mike's own facts (managed_key NULL) are never touched.
ALTER TABLE vault_facts ADD COLUMN managed_key TEXT;

-- One auto-built Vault note per tax year ("Tax Packet · 2026"); each live
-- folder's template adds its own managed facts to it.
CREATE TABLE IF NOT EXISTS statement_tax_packets (
  year INTEGER PRIMARY KEY,
  vault_entry_id TEXT NOT NULL
);
