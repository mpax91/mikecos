-- Next-day "Debrief: <meeting>" tasks (Mike, 2026-10-13): a Work meeting
-- that ended with no brief / pasted notes filed gets one, due the next day;
-- filing a brief for it checks the task off.
CREATE TABLE meeting_debrief_tasks (
  meeting_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
