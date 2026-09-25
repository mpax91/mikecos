-- Inbox — a live status board over Mike's real Gmail inboxes (IMAP), not a
-- built-in mail client. See worker/src/email.ts and worker/src/imapClient.ts
-- for the sync engine; this schema just mirrors "what's true right now" plus
-- MikeOS's own processed/read state, per account.

-- One row per connected mailbox. app_password_enc is a Gmail App Password
-- (2-Step Verification required on the Google account), AES-256-GCM
-- encrypted via cryptoField.ts's EMAIL_ACCOUNT_ENC_KEY — never stored or
-- returned in the clear. imap_host/smtp_host default to Gmail's own
-- endpoints but are columns (not hardcoded) so a Google Workspace account on
-- a custom domain, or a different provider down the road, isn't blocked.
CREATE TABLE email_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,           -- Mike's own name for it ("Personal", "Bee")
  email TEXT NOT NULL,
  app_password_enc TEXT NOT NULL,
  imap_host TEXT NOT NULL DEFAULT 'imap.gmail.com',
  imap_port INTEGER NOT NULL DEFAULT 993,
  smtp_host TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port INTEGER NOT NULL DEFAULT 465,
  icon TEXT NOT NULL DEFAULT '📧',
  color TEXT NOT NULL DEFAULT '#2F4A3C',
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,      -- paused accounts are skipped by the cron sync
  last_synced_at TEXT,
  last_error TEXT,                        -- surfaced in Settings so a broken app password is obvious, not silent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per message ever seen in an account's INBOX. Keyed on Gmail's own
-- X-GM-MSGID (a stable id across the whole account regardless of which
-- folder/label it's currently under) rather than IMAP's per-folder UID —
-- UIDs are only stable within one mailbox's UIDVALIDITY epoch, and a
-- message that leaves and re-enters INBOX (an unsnooze, a manual re-add)
-- gets a *new* UID each time. Keying on gm_msgid means that round trip is
-- recognized as the same email, not a fresh duplicate — see the snooze
-- discussion this was designed around.
--
-- in_inbox tracks "is this currently in the real INBOX" (set to 0 the
-- moment a poll's UID SEARCH no longer finds it there — archived, snoozed,
-- or moved by a filter); is_read mirrors the provider's own \Seen flag;
-- processed_at is entirely MikeOS's own concept — Mike marking something
-- handled here, independent of whatever Gmail's read state says. A message
-- typically leaves the visible feed by being archived (in_inbox = 0),
-- which is the same action as "processed" per Mike's own workflow, but the
-- columns are kept separate since a message can be read-and-in-inbox
-- (needs processing) without being archived yet.
CREATE TABLE email_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  gm_msgid TEXT NOT NULL,     -- Gmail's X-GM-MSGID, decimal string (can exceed JS safe-int range)
  gm_thrid TEXT,              -- Gmail's X-GM-THRID — kept for a future "reply stays in thread" feature
  uid INTEGER NOT NULL,       -- IMAP UID as of the most recent poll where this message was seen in INBOX
  message_id_header TEXT,     -- the RFC822 Message-ID header — used to thread a reply (In-Reply-To/References)
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  from_email TEXT,
  snippet TEXT,                        -- best-effort preview text — see imapClient.ts's known MIME limitation
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,  -- mirrors the provider's \Seen flag, synced both directions
  in_inbox INTEGER NOT NULL DEFAULT 1, -- 0 once a poll no longer finds it in INBOX (archived/snoozed/filtered away)
  processed_at TEXT,                   -- set when Mike explicitly marks it handled in MikeOS (archive also sets this)
  converted_to_entity_id TEXT,         -- set if "Make a Task"/"Save as Note"/"Attach to Project" was used on it
  first_seen_at TEXT NOT NULL,         -- when MikeOS first saw this message — drives the "New" vs "Needs Processing" split
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, gm_msgid)
);

CREATE INDEX idx_email_messages_account_inbox ON email_messages(account_id, in_inbox);
CREATE INDEX idx_email_messages_gm_msgid ON email_messages(account_id, gm_msgid);

-- A small outbox of actions taken in MikeOS that still need to reach the
-- real mailbox — archiving or marking read from the UI doesn't open a live
-- IMAP connection on the spot, it queues here and the next cron sync
-- (already connecting to every account anyway) applies it. Keeps the write
-- path instant in the UI without needing a connection per click.
CREATE TABLE email_pending_actions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  message_id TEXT NOT NULL REFERENCES email_messages(id),
  action TEXT NOT NULL CHECK(action IN ('archive', 'mark_read', 'mark_unread')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX idx_email_pending_actions_pending ON email_pending_actions(account_id, applied_at);
