-- "To raise with <person> next time" (Mike, 2026-10-13): highlight text in a
-- note → 👤 Person. Shows on their contact card and in the prep for any
-- meeting they're on until Mike checks it off as discussed (done_at).
CREATE TABLE person_agenda (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source_note_id TEXT,
  realm TEXT NOT NULL DEFAULT 'work',
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX idx_person_agenda_contact ON person_agenda(contact_id, done_at);
