-- Bedford Bee post grades A–F (2026-10-14) — worker/src/bee/grades.ts.
-- Grades are computed on read; this holds Mike's tuned weights/cutoffs
-- (NULL = defaults in code) and a short history so a young post's grade
-- can show which way it's moving.

CREATE TABLE bee_grade_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT,
  updated_at TEXT
);
INSERT INTO bee_grade_settings (id) VALUES (1);

CREATE TABLE bee_grade_history (
  kind TEXT NOT NULL,      -- fb | ig | substack
  id TEXT NOT NULL,        -- Meta post id | Substack post_date
  at TEXT NOT NULL,        -- ISO UTC
  letter TEXT,
  rank REAL,
  score REAL,
  PRIMARY KEY (kind, id, at)
);
CREATE INDEX idx_bee_grade_history_at ON bee_grade_history(at);
