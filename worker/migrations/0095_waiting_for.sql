-- Waiting For (Mike, 2026-10-08): after checking off a task, a toast offers
-- "Follow up in 7 days" (adjustable). Accepting creates a standalone
-- check-back task ("Check Back: <task>") due that many days out — it shows
-- on Today/Calendar like any task and is listed under Plan → Waiting For.
-- waiting_source_id = the task that was handed off; waiting_since = when
-- (YYYY-MM-DD, the day the toast was accepted).
ALTER TABLE entities ADD COLUMN waiting_source_id TEXT;
ALTER TABLE entities ADD COLUMN waiting_since TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_waiting ON entities (waiting_source_id) WHERE waiting_source_id IS NOT NULL;
