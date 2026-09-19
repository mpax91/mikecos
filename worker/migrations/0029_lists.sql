-- Lists — named, flat checklists (e.g. "To Buy", "To Download", a one-off
-- "To Shop" for a grocery run), living alongside Projects but intentionally
-- shallower: no sub-folders, no project dashboard. A List is stored as an
-- ordinary top-level type='project' row with this marker flag set, exactly
-- the way a Jot is a type='note' row with is_jot set (see
-- migrations/0005_jots.sql) — list ITEMS are then just ordinary type='task'
-- children of that row, which is what makes every existing task feature
-- (description, due date, subtasks, file/link attachments, the Today
-- integration when an item gets a due date) apply to list items for free,
-- with zero additional code.
--
-- Purely additive — ADD COLUMN only. `entities` is never recreated on this
-- database; see 0005_jots.sql / 0006_planner.sql for the documented
-- production incident that rule exists to prevent.
ALTER TABLE entities ADD COLUMN is_list INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_entities_is_list ON entities(is_list);
