-- Links each aired-but-missing episode to the "Download <Show> SxxExx" task
-- created for it, so completing the loop (the episode shows up in the
-- library, or Mike dismisses it) can clean up that same task instead of
-- leaving it dangling. NULL for rows inserted before this shipped, and for
-- any future row where task creation itself failed — never load-bearing.
ALTER TABLE plex_missing_episodes ADD COLUMN task_id TEXT;
