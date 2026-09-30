-- Adds failure visibility to email_pending_actions. Until now a failed
-- action (archive/trash/mark_read/mark_unread never actually landing on
-- Gmail) was only ever console.error'd from the Worker's scheduled/manual
-- sync handler — invisible without tailing production logs. Mike reported
-- archived messages silently reappearing even after the UID-mismatch fix in
-- 4ba153d, which means something is still failing (or Gmail genuinely isn't
-- applying the STORE) on every retry without ever surfacing why. These
-- columns let /api/email/accounts/:id/debug-archive show the real error
-- text and how many times each action has been retried.
ALTER TABLE email_pending_actions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_pending_actions ADD COLUMN last_error TEXT;
ALTER TABLE email_pending_actions ADD COLUMN last_attempted_at TEXT;
