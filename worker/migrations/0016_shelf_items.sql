-- The "Shelf" — a self-clearing drop zone on the Jots page for parking
-- text snippets, screenshots, links, and files mid-task (Edge Drop-style),
-- distinct from Jots themselves: no title, no rich-text body, and it ages
-- itself out instead of needing the Tickler to nag you into cleaning it
-- up. Brand-new table, so CREATE TABLE is safe (see 0011_task_completions
-- .sql for why that's always true for a new table).
--
-- `type` is one of 'text' | 'image' | 'link' | 'file' — same
-- deliberately-not-a-CHECK-constraint choice as canvas_items.type, so a
-- new kind is just a new value. `content` is type-shaped JSON:
--   text:  { text }
--   image: { r2_key, mime_type, filename }
--   file:  { r2_key, mime_type, filename }
--   link:  { url, title, domain, image }
-- `pinned` exempts an item from the auto-clear sweep (see GET /api/shelf)
-- for the rare thing worth parking longer than a week without graduating
-- it into a real Jot.
CREATE TABLE shelf_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_shelf_items_created ON shelf_items(created_at);
