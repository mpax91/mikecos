-- Connector arrows between canvas items ("Boards" feature, fast-follow to
-- 0012_canvas_boards.sql). A brand-new table, so CREATE TABLE is safe here
-- (see 0011_task_completions.sql for why that's always true for a new
-- table, vs. the DROP-TABLE landmine that rules out ever recreating
-- `entities` itself).
--
-- Deliberately just from_item_id/to_item_id — no stored anchor point or
-- side. The actual line endpoints are computed at render time from each
-- item's current x/y/width/height (nearest-edge-midpoint), which is what
-- makes an arrow "move with" its cards automatically as they're dragged,
-- with nothing to keep in sync.
CREATE TABLE canvas_connectors (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  from_item_id TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_canvas_connectors_board ON canvas_connectors(board_id);
