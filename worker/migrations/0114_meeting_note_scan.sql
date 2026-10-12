-- Mike's own meeting notes are read for next steps (Mike, 2026-10-12).
-- Each scanned note keeps one meeting_summaries row with source 'own_note'
-- (summary/details/decisions empty; note_entity_id = the note) so its next
-- steps flow through the same meeting_actions → My Task / Waiting On path as
-- Gemini notes. scanned_at = the note's updated_at when it was last read, so
-- a note is re-read only after it changes.
ALTER TABLE meeting_summaries ADD COLUMN scanned_at TEXT;
