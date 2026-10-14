-- Pasting a brief no longer creates a calendar meeting. Briefs that had made
-- an all-day one-off ("Added from a pasted brief.") move onto a `brief-<id>`
-- stand-in (off the calendar); rehomeBriefs still moves them onto the real
-- meeting once one matches. One-off ids are 'ms-<id>' (no rrule → no
-- ':<ISO>' suffix), so the new key is 'brief-' || substr(old, 4).
UPDATE meeting_summaries SET meeting_id = 'brief-' || substr(series_key, 4), series_key = 'brief-' || substr(series_key, 4)
  WHERE series_key IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE meeting_actions SET meeting_id = 'brief-' || substr(series_key, 4), series_key = 'brief-' || substr(series_key, 4)
  WHERE series_key IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE meeting_items SET meeting_id = 'brief-' || substr(series_key, 4), series_key = 'brief-' || substr(series_key, 4)
  WHERE series_key IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE meeting_assists SET meeting_id = 'brief-' || substr(meeting_id, 4)
  WHERE meeting_id IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE contact_context SET meeting_id = 'brief-' || substr(meeting_id, 4)
  WHERE meeting_id IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE meeting_notes SET meeting_id = 'brief-' || substr(meeting_id, 4)
  WHERE meeting_id IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
UPDATE meeting_docs SET series_key = 'brief-' || substr(series_key, 4)
  WHERE series_key IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
DELETE FROM meeting_prep_tasks
  WHERE meeting_id IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
DELETE FROM meeting_debrief_tasks
  WHERE meeting_id IN (SELECT 'ms-' || id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
DELETE FROM meeting_series_people
  WHERE series_id IN (SELECT id FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL);
DELETE FROM meeting_series WHERE description = 'Added from a pasted brief.' AND rrule IS NULL;
