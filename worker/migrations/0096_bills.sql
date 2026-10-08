-- Bills & Due Dates (Mike, 2026-10-08). See worker/src/bills.ts.
--
-- One row per bill. source 'statement' = a live bill/card Statements folder
-- (created and kept current automatically: auto_due_day / auto_autopay are
-- what the statements say, the same numbers as the Due Date / Auto-Pay
-- Quick Facts). source 'manual' = a bill Mike added (no statements).
--
-- due_day / autopay: on a manual bill, what Mike typed; on a statement
-- bill, Mike's own edit, which wins over the statements until he resets it
-- (NULL = follow the statements).
--
-- Not on Auto-Pay → recurring_id points at a recurring_task_definitions row
-- (bill_id set, hidden from Settings → Recurring Tasks) that spawns one
-- "Pay <bill>" task a month on the due day. On Auto-Pay → no task; the
-- Calendar shows a non-checkable Auto-Pay entry instead.
CREATE TABLE IF NOT EXISTS bills (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,              -- statement | manual
  folder_id     TEXT UNIQUE,                -- statement_folders.id (statement bills)
  entry_id      TEXT,                       -- the account's Vault entry (statement bills)
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  due_day       INTEGER,                    -- 1–31
  autopay       INTEGER,                    -- 0|1
  amount        REAL,                       -- typical amount (manual bills)
  auto_due_day  INTEGER,
  auto_autopay  INTEGER,
  recurring_id  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

ALTER TABLE recurring_task_definitions ADD COLUMN bill_id TEXT;
