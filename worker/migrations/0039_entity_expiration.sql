-- Expiring documents — a note or file entity (insurance card, registration,
-- inspection sticker, a passport scan, a warranty PDF... anywhere in the
-- app, not just Vault) can carry an expiration date. Setting one
-- auto-creates a real task entity due 30 days before that date, so it
-- shows up in Today exactly like any other task — no separate "expiring
-- soon" subsystem needed, since due_date/Today already does the job.
--
-- expiry_task_id points at that auto-created task so it can be found again
-- to update its due date (expiration changed) or delete it (expiration
-- cleared, or the source note/file itself deleted) instead of leaving
-- orphaned or duplicate reminder tasks behind. It's on entities rather than
-- a separate join table because the relationship is strictly 1:1 and only
-- ever touched from the owning row.
--
-- Plain ALTER TABLE ADD COLUMN is safe here — same rule this app always
-- follows for entities (see 0005_jots.sql): never recreate an existing
-- table, only ever add columns to it.
ALTER TABLE entities ADD COLUMN expires_at TEXT;
ALTER TABLE entities ADD COLUMN expiry_task_id TEXT REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX idx_entities_expires_at ON entities(expires_at) WHERE expires_at IS NOT NULL;
