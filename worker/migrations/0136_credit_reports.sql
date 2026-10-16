-- Finance → Credit Reports (Mike, 2026-10-16). One row per bureau report
-- (AnnualCreditReport.com pulls every Feb 22, plus older one-offs), stored
-- whole as JSON (shape: worker/src/credit/types.ts). Loaded through
-- POST /api/credit-reports/import — the repo is public, so no report data
-- ever lives in a migration. No SSNs, birth dates or full account numbers.
CREATE TABLE IF NOT EXISTS credit_reports (
  id TEXT PRIMARY KEY,          -- YYYY-MM-DD-bureau
  bureau TEXT NOT NULL,         -- equifax | experian | transunion | other
  pulled_on TEXT NOT NULL,      -- YYYY-MM-DD
  file_id TEXT,                 -- Drive file id of the PDF
  source TEXT NOT NULL DEFAULT 'import',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_reports_pulled ON credit_reports (pulled_on);

-- Accounts on a report that MikeOS doesn't track, confirmed as Mike's own
-- ("Mark as Mine") — keyed by the merged account key (brand:opened month).
CREATE TABLE IF NOT EXISTS credit_report_known (
  account_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Yearly reminder on Mike's ritual date, Feb 22 (first one 2027-02-22).
INSERT OR IGNORE INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at, realm)
VALUES ('credit-reports', 'Pull Free Credit Reports (Equifax, Experian, TransUnion)', NULL, 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=22', '2027-02-22', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'personal');
