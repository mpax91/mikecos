-- The Bar — home spirits/wine/beer inventory + a Vivino/Untappd-style
-- tasting log. Two tables, deliberately decoupled: bar_items is the
-- physical/conceptual thing (a bottle of gin, a wine you keep buying, a
-- six-pack), bar_tastings is each time you actually drank and scored one.
-- Splitting them is what lets a wine's score history survive its quantity
-- hitting zero — Mike explicitly wants to pull up "what did I think of
-- that Barolo" for a bottle he no longer has.
--
-- One shared items table across all three types rather than three separate
-- tables — spirits/wine/beer differ only in which optional fields get
-- filled in (a spirit has no vintage or drink window; a beer has no
-- region), and a shared shape is what makes one bulk-import flow and one
-- tastings table work for all three without duplicating the CRUD/quantity/
-- tasting logic three times over.
CREATE TABLE bar_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('spirit', 'wine', 'beer')),
  name TEXT NOT NULL,
  category TEXT,           -- spirit: Gin/Vodka/Whiskey/etc; wine: varietal; beer: style — freeform, UI-suggested not enforced
  producer TEXT,           -- distillery / winery / brewery
  vintage INTEGER,         -- wine only
  region TEXT,             -- wine only
  quantity INTEGER NOT NULL DEFAULT 1,
  drink_window_start INTEGER, -- wine only — e.g. 2028
  drink_window_end INTEGER,   -- wine only — e.g. 2029
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_bar_items_type ON bar_items(type);
CREATE INDEX idx_bar_items_name ON bar_items(name COLLATE NOCASE);

CREATE TABLE bar_tastings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES bar_items(id),
  consumed_at TEXT,        -- YYYY-MM-DD, optional (a rough "sometime" tasting is still worth logging)
  score REAL,              -- 0.5-5.0 in 0.5 steps; NULL if he just wants to log notes without a rating
  tags TEXT,                -- JSON array of short tap-to-toggle descriptors (fruity, tannic, oaky, ...)
  notes TEXT,
  buy_again INTEGER,        -- 0/1, NULL = not answered
  created_at TEXT NOT NULL
);

CREATE INDEX idx_bar_tastings_item ON bar_tastings(item_id);
CREATE INDEX idx_bar_tastings_score ON bar_tastings(score);
