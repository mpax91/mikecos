-- Lets any entity be pinned to the top of its listing (projects on the
-- homescreen; folders/notes/tasks within a project).
ALTER TABLE entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(pinned);
