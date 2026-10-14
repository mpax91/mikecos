-- Auto-Pay markers on Today can be dismissed (Mike, 2026-10-14): one row per
-- bill per due date. Dismissing hides that day's marker from Today only —
-- Week and Month keep showing it as a calendar record. Next month's marker
-- is a new date, so it shows again.
CREATE TABLE IF NOT EXISTS autopay_dismissals (
  bill_id TEXT NOT NULL,
  date TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (bill_id, date)
);
