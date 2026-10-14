-- Notes-first everywhere (Mike, 2026-10-13): Mike's own 📝 notes are no
-- longer read into to-sort next steps, and pasted Gemini notes record next
-- steps instead of asking. Clear what was waiting.
DELETE FROM meeting_actions
 WHERE status = 'pending' AND summary_id IN (SELECT id FROM meeting_summaries WHERE source = 'own_note');
UPDATE meeting_actions SET status = 'noted' WHERE status = 'pending';
