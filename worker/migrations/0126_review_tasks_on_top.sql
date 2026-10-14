-- Prep tasks, then Review tasks, at the top of their day (Mike, 2026-10-13):
-- day lists sort by due_position first.
UPDATE entities SET due_position = -200
 WHERE type = 'task' AND status = 'open' AND substr(content, 1, 24) = '{"action":"meeting-prep"';
UPDATE entities SET due_position = -100
 WHERE type = 'task' AND status = 'open' AND substr(content, 1, 21) = '{"action":"open-note"';
