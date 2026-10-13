-- Structured "meeting-record" briefs pasted from Mike's work Claude Project
-- (worker/src/work/record.ts). One paste = one meeting_summaries row with
-- source 'record'; its pieces land in the tables below.

ALTER TABLE meeting_summaries ADD COLUMN kind TEXT;          -- debrief | prep | thread (NULL = Gemini / own note)
ALTER TABLE meeting_summaries ADD COLUMN format TEXT;        -- 'meeting-record/1'
ALTER TABLE meeting_summaries ADD COLUMN record_json TEXT;   -- the normalized record

ALTER TABLE meeting_actions ADD COLUMN confidence TEXT;      -- 'stated' | 'implied' (records only)
ALTER TABLE meeting_actions ADD COLUMN due_date TEXT;        -- YYYY-MM-DD from the record → the task's due date
ALTER TABLE meeting_actions ADD COLUMN record_action_id TEXT;
ALTER TABLE meeting_actions ADD COLUMN owner_email TEXT;

-- Decisions, open questions, watch-outs, materials, and prep goals /
-- talking points / questions. Open questions + watch-outs stay "Still Open"
-- in the series' next prep until Mike checks them off (resolved_at).
CREATE TABLE meeting_items (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  kind TEXT NOT NULL,          -- decision | question | watch_out | material | goal | talking_point | prep_question
  text TEXT NOT NULL,
  extra TEXT,                  -- material: JSON {type, takeaway}
  position INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mitems_summary ON meeting_items(summary_id);
CREATE INDEX idx_mitems_series ON meeting_items(series_key, kind);

-- "Where AI Can Help" prompts. action_id = the meeting_actions row the
-- prompt helps with (its task gets a Copy AI Prompt button).
CREATE TABLE meeting_assists (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  action_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_massists_summary ON meeting_assists(summary_id);
CREATE INDEX idx_massists_action ON meeting_assists(action_id);

-- What was learned about a person (record people[].context), shown on the
-- contact card under "What I've Learned".
CREATE TABLE contact_context (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  summary_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  date TEXT NOT NULL,          -- YYYY-MM-DD of the meeting / thread
  fact TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cctx_contact ON contact_context(contact_id, date);
CREATE INDEX idx_cctx_summary ON contact_context(summary_id);
