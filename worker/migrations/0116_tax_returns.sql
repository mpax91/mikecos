-- Finance → Taxes (Mike, 2026-10-12): one row per filed tax year. The return's
-- key lines (federal 1040, NY IT-201, CT nonresident) live in data_json in the
-- shape documented in worker/src/taxes/types.ts. Figures were extracted once
-- from the PDFs in the two Drive "Taxes" folders and imported through
-- POST /api/taxes/import (never committed to the repo); Mike edits a year in
-- the app. No SSNs, account numbers or addresses are ever stored here.
CREATE TABLE IF NOT EXISTS tax_returns (
  year INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'import', -- 'import' | 'manual'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
