-- Project-level Archive. Projects (and Lists, which share the same
-- type='project' row shape) already carried status 'active' | 'archived'
-- since 0001_init.sql, but nothing ever set 'archived'. This adds when it
-- happened, for the "Archived Oct 4 · Restore" banner. Archiving never
-- moves or deletes anything — the whole subtree just gets filtered out of
-- the Projects/Lists pages, Today, Overdue, the day planner, the briefing
-- and recurring-task spawning (see ARCHIVED_TREE_CTE in worker/src/index.ts).
ALTER TABLE entities ADD COLUMN archived_at TEXT;
