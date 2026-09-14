-- Contact/voter-file import — see worker/src/index.ts's "Contact import"
-- section for the parsing and matching logic. Two new tables, both safe as
-- plain CREATE TABLE (see 0011_task_completions.sql), plus one additive
-- ALTER on the existing contacts table.
--
-- `import_batches` is the audit trail Settings shows ("last imported
-- Tuesday, 40 new, 12 updated") and, longer-term, what a future "undo this
-- import" would key off of — every contact an import creates or touches
-- carries its batch id.
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'contacts' | 'voter_file'
  filename TEXT NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

ALTER TABLE contacts ADD COLUMN import_batch_id TEXT;

-- One row per matched-or-created contact from a voter file row. Deliberately
-- lean, structured columns for what's commonly useful (party, age,
-- household, voting history as JSON) plus `raw_data` holding the entire
-- original CSV row as JSON — county voter file formats vary, so this is
-- what keeps an import lossless even for columns this app doesn't have a
-- dedicated field for yet.
CREATE TABLE voter_records (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  party TEXT,
  voter_age INTEGER,
  household_members TEXT, -- JSON string[]
  voting_history TEXT, -- JSON, shape as provided by the source file
  raw_data TEXT NOT NULL, -- JSON — the full original row, for fidelity
  import_batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_voter_records_contact ON voter_records(contact_id);
