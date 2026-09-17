-- A quick note attached to one specific calendar-event occurrence, keyed
-- by the same id MeetingItem.id already uses (the ICS UID, or
-- "<uid>:<occurrence start ISO>" for one occurrence of a recurring
-- event — see ics.ts's meetingsForRange). Meetings themselves are never
-- persisted in D1 (they're parsed live from the ICS feed on every
-- request), so this table is the only place a meeting-note relationship
-- lives; meeting_title/meeting_start are a snapshot taken at save time so
-- the note still reads sensibly even if the source calendar event is
-- later renamed, moved, or the feed itself is removed.
--
-- Deliberately one row per meeting, not a feed of many like contact_notes
-- — Mike asked for a note that "sticks to that meeting", i.e. a single
-- running note you open and edit, not a log. Nothing is inserted here
-- just from opening/viewing a meeting; a row only exists once text has
-- actually been saved (see PUT /api/meetings/:meetingId/note, which
-- deletes the row again if the text is edited back down to blank) — so
-- meeting_notes existing for an id doubles as "has Mike written anything
-- about this meeting" without a separate boolean anywhere.
CREATE TABLE meeting_notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE,
  meeting_title TEXT,
  meeting_start TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_meeting_notes_meeting ON meeting_notes(meeting_id);
