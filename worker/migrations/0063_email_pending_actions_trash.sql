-- The 'trash' pending-action type (added so Delete queues a real Gmail
-- trash via IMAP, same pattern as archive/mark_read/mark_unread) was
-- never added to this table's CHECK constraint — every insert of a
-- 'trash' row was silently violating it, failing the whole batch, which
-- is why clicking Delete did nothing: the confirm dialog's request threw,
-- so the modal never closed and nothing changed in MikeOS or Gmail.
-- SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT, so this rebuilds the
-- table with the corrected CHECK, preserving any rows already queued.

CREATE TABLE email_pending_actions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  message_id TEXT NOT NULL REFERENCES email_messages(id),
  action TEXT NOT NULL CHECK(action IN ('archive', 'mark_read', 'mark_unread', 'trash')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

INSERT INTO email_pending_actions_new (id, account_id, message_id, action, created_at, applied_at)
SELECT id, account_id, message_id, action, created_at, applied_at FROM email_pending_actions;

DROP TABLE email_pending_actions;
ALTER TABLE email_pending_actions_new RENAME TO email_pending_actions;

CREATE INDEX idx_email_pending_actions_pending ON email_pending_actions(account_id, applied_at);
