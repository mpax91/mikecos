-- Gemini-paste notes get "· Gemini Notes" so they don't look like
-- duplicates of the Claude brief's note for the same meeting (2026-10-13).
UPDATE entities SET title = title || ' · Gemini Notes'
 WHERE type = 'note'
   AND id IN (SELECT note_entity_id FROM meeting_summaries WHERE source IN ('gemini', 'manual') AND note_entity_id IS NOT NULL)
   AND instr(title, ' | ') = 11
   AND substr(title, -15) != ' · Gemini Notes';
