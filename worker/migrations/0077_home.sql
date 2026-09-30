-- Home: a to-scale digital floor plan. Not a generic Board — a purpose-
-- built spatial reference for the house itself, in the same spirit as
-- Vault/Wallet/Bar (structured reference data you look things up in, not
-- active work). See worker/src/home.ts for the full design rationale.
--
-- Coordinate system: every x/y/width/depth is stored in whole INCHES, so
-- the floor canvas is literally to-scale — a couch drawn 84" wide really
-- is 84" wide relative to the room it's sitting in, which is the whole
-- point (checking furniture fit before buying, not just diagramming).
-- Room x/y is its position on the floor canvas; a fixture's x/y is
-- relative to its OWN room's top-left corner, so dragging a room to a new
-- spot on the floor carries its fixtures along for free at render time
-- (room.x + fixture.x) rather than needing every fixture rewritten.
--
-- home_fixtures is one shared table across all five fixture kinds
-- (appliance/furniture/outlet/switch/fixture) rather than five separate
-- tables — same reasoning as bar_items: they differ only in a few
-- optional fields (footprint dimensions matter for appliance/furniture,
-- not really for a point-symbol like an outlet), not in shape.
--
-- vault_entry_id is a plain TEXT reference to entities.id (a vault_entry
-- row) — no FK constraint, matching the rest of this schema's convention
-- of app-level integrity rather than enforced foreign keys.

CREATE TABLE home_floors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE home_rooms (
  id TEXT PRIMARY KEY,
  floor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_home_rooms_floor ON home_rooms(floor_id);

CREATE TABLE electrical_panels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE electrical_breakers (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL,
  number TEXT NOT NULL,
  label TEXT,
  amperage INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_electrical_breakers_panel ON electrical_breakers(panel_id);

CREATE TABLE home_fixtures (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('appliance', 'furniture', 'outlet', 'switch', 'fixture')),
  label TEXT NOT NULL,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 6,
  depth INTEGER NOT NULL DEFAULT 6,
  vault_entry_id TEXT,
  breaker_id TEXT,
  smart_device INTEGER NOT NULL DEFAULT 0,
  smart_notes TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_home_fixtures_room ON home_fixtures(room_id);
CREATE INDEX idx_home_fixtures_breaker ON home_fixtures(breaker_id);
