-- Work ↔ Personal, round 2 (Mike, 2026-10-11).

-- Links: Quick Links and imported bookmarks get a realm too (Work mode shows
-- only Birches links; importing bookmarks while on Work replaces only the
-- Work set).
ALTER TABLE quick_links ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE bookmarks ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';

-- Journal: one entry per day with a Personal and a Work part. Work mode
-- shows only the Work part; All shows both.
ALTER TABLE journal_entries ADD COLUMN work_content TEXT;
ALTER TABLE journal_entries ADD COLUMN work_search_text TEXT;

-- Contacts carrying this Google label count as Work (plus any contact
-- marked Work by hand). New contacts made in Work mode get the label.
INSERT OR IGNORE INTO work_settings (key, value) VALUES ('work_label', 'Birches');

-- Briefs become two Work tasks instead of a page: "Plan the Week" on
-- Mondays and "Weekly Review" on Fridays (each opens its brief). Both are
-- ordinary recurring tasks — edit or delete them in Settings → Recurring
-- Tasks.
INSERT OR IGNORE INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at, realm)
VALUES
  ('work-week-plan', 'Plan the Week', NULL, 'FREQ=WEEKLY;BYDAY=MO', '2026-10-19', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'work'),
  ('work-week-review', 'Weekly Review — What Got Done', NULL, 'FREQ=WEEKLY;BYDAY=FR', '2026-10-16', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'work');
