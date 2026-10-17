-- Clearer title for the Saturday Throwback Thursday reminder (was "Pick This Week's Throwback").
UPDATE recurring_task_definitions
SET title = 'Pick This Week''s Bedford Bee Throwback Post',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'bee-throwback';

-- Rename the task instance already generated (e.g. today's), if still open.
UPDATE entities
SET title = 'Pick This Week''s Bedford Bee Throwback Post',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'task'
  AND title = 'Pick This Week''s Throwback'
  AND status <> 'done';
