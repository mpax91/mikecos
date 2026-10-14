-- Briefs become notes-first (Mike, 2026-10-13): pasting a brief files the
-- note and a next-day "Review" task — nothing waits to be sorted. Mike acts
-- by highlighting text in the note (task / waiting / project / list / jot /
-- link), which records where it came from in entities.source_note_id.

ALTER TABLE entities ADD COLUMN source_note_id TEXT;
CREATE INDEX idx_entities_source_note ON entities(source_note_id);

ALTER TABLE meeting_summaries ADD COLUMN review_task_id TEXT;

-- Next steps already filed from briefs stop asking to be sorted: they're
-- kept as the meeting's record ('noted') for carry-forward.
UPDATE meeting_actions SET status = 'noted'
 WHERE status = 'pending' AND summary_id IN (SELECT id FROM meeting_summaries WHERE source = 'record');

-- Tasks made from meeting next steps without a date → the day after they
-- were made (Mike's default: next day).
UPDATE entities SET due_date = date(created_at, '-4 hours', '+1 day')
 WHERE type = 'task' AND status = 'open' AND due_date IS NULL
   AND id IN (SELECT entity_id FROM meeting_actions WHERE status = 'task' AND entity_id IS NOT NULL);

-- Note titles: "Meeting Notes · Title · MM/DD/YYYY" → "YYYY.MM.DD | Title"
-- (prep → "YYYY.MM.DD | Prep · Title", threads keep "Slack · Title").
UPDATE entities
   SET title =
     substr(title, -4) || '.' || substr(title, -10, 2) || '.' || substr(title, -7, 2) || ' | ' ||
     CASE
       WHEN title LIKE 'Meeting Notes · %' THEN ''
       WHEN title LIKE 'Meeting Prep · %' THEN 'Prep · '
       ELSE substr(title, 1, instr(title, ' · ') - 1) || ' · '
     END ||
     substr(title, instr(title, ' · ') + 3, length(title) - (instr(title, ' · ') + 2) - 13)
 WHERE type = 'note'
   AND id IN (SELECT note_entity_id FROM meeting_summaries WHERE note_entity_id IS NOT NULL AND source != 'own_note')
   AND title GLOB '* · * · [0-9][0-9]/[0-9][0-9]/[0-9][0-9][0-9][0-9]';

-- A Review task for briefs already filed (due the day after the meeting).
INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
SELECT lower(hex(randomblob(16))), 'task',
       'Review: ' || s.meeting_title,
       '{"action":"open-note","noteId":"' || s.note_entity_id || '"}',
       NULL, 1, 'open', 0,
       date(s.occurrence_start, '-4 hours', '+1 day'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'Review: ' || s.meeting_title, s.realm
  FROM meeting_summaries s
 WHERE s.source = 'record' AND s.kind IN ('debrief', 'thread') AND s.note_entity_id IS NOT NULL AND s.review_task_id IS NULL;

UPDATE meeting_summaries
   SET review_task_id = (SELECT e.id FROM entities e WHERE e.type = 'task' AND e.content = '{"action":"open-note","noteId":"' || meeting_summaries.note_entity_id || '"}' LIMIT 1)
 WHERE source = 'record' AND kind IN ('debrief', 'thread') AND note_entity_id IS NOT NULL AND review_task_id IS NULL;
