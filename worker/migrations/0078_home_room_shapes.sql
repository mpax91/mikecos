-- Home v2: odd-shaped rooms + wall-mounted doors/windows.
--
-- home_rooms.points is the room's real shape now: a JSON array of
-- {x,y} corner points, in whole inches, forming a closed RECTILINEAR
-- polygon (every wall horizontal or vertical — covers L-shapes, notches,
-- bump-outs without needing a freeform-angle editor). The points are
-- relative to the room's own bounding-box top-left, i.e. min(x)=0 and
-- min(y)=0 across all points always — room.x/room.y (already on the
-- table) is that bounding box's position on the floor, exactly as
-- before. width/depth stay on the table too, but now mean "the room's
-- bounding box" rather than "the room's shape" — a plain rectangle is
-- the simplest case where the bounding box IS the shape (points is the
-- 4 corners of that same box). Every existing room gets points backfilled
-- from its current width/depth so nothing changes visually until you
-- actually reshape something.
--
-- home_wall_items is doors and windows: mounted to one specific wall
-- segment of a room's polygon (wall_index into room.points, 0 = the
-- edge from points[0] to points[1], and so on around, wrapping), offset
-- inches along that wall from its start corner, and width inches along
-- the wall. swing is doors only (which end is the hinge, for drawing
-- the swing arc) — null for windows. Links to Vault the same way
-- fixtures do (a window's exact measurements for blinds, a door's
-- hardware info), same no-FK convention as the rest of this schema.

ALTER TABLE home_rooms ADD COLUMN points TEXT;

UPDATE home_rooms
SET points = '[{"x":0,"y":0},{"x":' || width || ',"y":0},{"x":' || width || ',"y":' || depth || '},{"x":0,"y":' || depth || '}]'
WHERE points IS NULL;

CREATE TABLE home_wall_items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('door', 'window')),
  label TEXT NOT NULL,
  wall_index INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 30,
  swing TEXT CHECK (swing IN ('left', 'right')),
  vault_entry_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_home_wall_items_room ON home_wall_items(room_id);
