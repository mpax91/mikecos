-- Calls & Texts (2026-10-11). MikeOS reads Mike's phone backups (SMS Backup
-- & Restore → Drive folder "SMS": calls-*.xml + sms-*.xml, a full backup
-- every night) and keeps ROLLUPS only — no message text, no call log rows.
-- Phone numbers are stored as an HMAC (CLOUD_ACCOUNT_ENC_KEY) of the last
-- 10 digits, never in plain text; a contact's numbers are hashed the same
-- way at read time, so contacts added or merged later pick up their history.
-- worker/src/comms/.

CREATE TABLE comm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_account_id TEXT,
  folder_id TEXT,
  folder_name TEXT,
  folder_url TEXT,
  calls_file_id TEXT,          -- newest calls file already read
  calls_wm INTEGER,            -- newest call (epoch ms) counted
  sms_file_id TEXT,            -- newest sms file whose plain-text block was read
  sms_wm INTEGER,              -- newest plain text counted
  mms_file_id TEXT,            -- sms file whose chat/picture block was read to the end
  mms_wm INTEGER,              -- newest chat/picture message counted
  mms_done INTEGER NOT NULL DEFAULT 0,
  sms_file_size INTEGER,
  first_at INTEGER,            -- oldest message/call counted
  last_scan_at TEXT,
  last_error TEXT,
  stats_json TEXT
);
INSERT INTO comm_settings (id) VALUES (1);

-- Per number per month: kind = call_in | call_out | call_missed | text_in |
-- text_out | group_in (a message they sent to a group chat you're in).
CREATE TABLE comm_monthly (
  num_hash TEXT NOT NULL,
  month TEXT NOT NULL,         -- YYYY-MM (Eastern)
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (num_hash, month, kind)
);

CREATE TABLE comm_last (
  num_hash TEXT PRIMARY KEY,
  last_call_at INTEGER,
  last_call_kind TEXT,
  last_text_at INTEGER,
  last_text_kind TEXT,
  last_group_at INTEGER
);

-- Group chats (by an HMAC of the chat's address / member list) and who's in them.
CREATE TABLE comm_group_members (
  group_hash TEXT NOT NULL,
  num_hash TEXT NOT NULL,
  last_at INTEGER,
  PRIMARY KEY (group_hash, num_hash)
);
CREATE INDEX idx_comm_group_members_num ON comm_group_members(num_hash);

CREATE TABLE comm_groups (
  group_hash TEXT PRIMARY KEY,
  members INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER
);
