-- Infinite-canvas whiteboard feature ("Boards" in the sidebar) — a spatial
-- pinboard distinct from the document-shaped Notes/Projects tree: photos,
-- clippings, and free-floating text arranged anywhere on an unbounded x/y
-- plane rather than in a linear list. Two brand-new tables, so CREATE TABLE
-- is safe here (see 0011_task_completions.sql for why that's always true
-- for a new table, vs. the DROP-TABLE landmine that rules out ever
-- recreating `entities` itself).
--
-- A board is a lightweight container (just a title) — the interesting state
-- is its items. board_count/item positions are all queried live rather than
-- denormalized, since this table is never large enough at Mike's
-- personal-app scale to need it.
CREATE TABLE canvas_boards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL -- bumped whenever the board's own title changes OR any item on it is added/moved/edited/deleted, so "recently active" sorting on the boards list reflects real canvas activity, not just renames
);

-- One row per free-floating item on a board. `type` is one of 'image',
-- 'text', 'note' (a colored sticky note) — deliberately not a CHECK
-- constraint (see entities.status elsewhere in this schema for the same
-- choice) so a new item type is just a new value, never a migration.
-- `content` is type-shaped JSON, same "shared free-form column" pattern as
-- entities.content:
--   image: { r2_key, mime_type, filename }
--   text:  { text }
--   note:  { text, color }
-- x/y are the item's top-left corner in board-space (unbounded, can be
-- negative — the canvas has no origin constraint). z_index is a simple
-- monotonically-increasing "bring to front" counter, not a dense stack —
-- gaps are fine, only relative order matters.
CREATE TABLE canvas_items (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  z_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_canvas_items_board ON canvas_items(board_id);
