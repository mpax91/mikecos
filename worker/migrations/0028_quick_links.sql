-- Quick Links — the sidebar "Links" section: a small, self-service tray of
-- one-click jumps (ChatGPT GPTs, Claude Projects, the Cal.com booking link,
-- whatever else) that otherwise get buried inside their own apps. Managed
-- entirely from Settings, per Mike's request — the Links page itself is
-- read-only/click-only, no inline add affordance there.
--
-- `type` is 'open' (click opens `url` in a new tab) or 'copy' (click copies
-- `url` to the clipboard instead — the Cal.com link, meant to be pasted into
-- an email/text rather than visited). `thumbnail_key` is an R2 object key
-- (same bucket/endpoint as note attachments, via POST /api/upload) for a
-- manually-uploaded square image; when null the tile falls back to `icon`,
-- a plain emoji. `category` is a freeform grouping label ("Scheduling",
-- "AI Tools", ...) — the Links page groups tiles by it in `sort_order`
-- order, so reordering across categories is just changing where a row's
-- sort_order falls relative to its neighbors. A brand-new table, so a plain
-- CREATE TABLE is safe; nothing about this touches `entities`.
CREATE TABLE IF NOT EXISTS quick_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'open' CHECK (type IN ('open', 'copy')),
  icon TEXT,
  thumbnail_key TEXT,
  category TEXT NOT NULL DEFAULT 'Links',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
