-- Home → Paint + every room in the house (2026-10-17).
-- Routes in worker/src/home.ts (/api/home/paints), UI
-- src/components/HomePaintPage.tsx (🎨 Paint pill) + HomeRoomPaintButton.tsx
-- (room view).

-- Rooms Mike hasn't measured yet start as a 10' × 10' placeholder with
-- measured = 0 (the room view says "Not Measured Yet"). Editing the size,
-- reshaping on the canvas or importing a spec sets it back to 1.
ALTER TABLE home_rooms ADD COLUMN measured INTEGER NOT NULL DEFAULT 1;

-- One row per painted surface in a room (Ceiling / Walls / Trim / Doors…),
-- the way a paint store's color sheet lists it. The tint formula is kept as
-- typed (one colorant per line) so a matching can be re-mixed.
CREATE TABLE home_paints (
  id TEXT PRIMARY KEY,
  room_id TEXT,              -- home_rooms.id (nulled when the room/floor is deleted — the color record stays)
  surface TEXT NOT NULL,     -- "Walls", "Ceiling", "Trim", "Accent Wall"… free text
  brand TEXT,                -- "Benjamin Moore"
  product TEXT,              -- "Aura", "Ceiling Paint"
  finish TEXT,               -- "Matte", "Ultra Flat", "Semi-Gloss"
  color_name TEXT,           -- "Wish", "White"
  color_code TEXT,           -- "AF-680", "OC-151"
  hex TEXT,                  -- optional swatch "#RRGGBB"
  formula TEXT,              -- tint formula, one line per colorant
  store TEXT,                -- where it was bought / mixed
  painted_on TEXT,           -- YYYY-MM-DD
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_home_paints_room ON home_paints(room_id);

-- Seed lists go through a scratch table (D1 rejects long compound SELECTs:
-- "too many terms in compound SELECT").
CREATE TABLE _seed_floors (name TEXT NOT NULL, pos INTEGER NOT NULL);
INSERT INTO _seed_floors VALUES ('Basement', 0);
INSERT INTO _seed_floors VALUES ('1st Floor', 1);
INSERT INTO _seed_floors VALUES ('2nd Floor', 2);
INSERT INTO _seed_floors VALUES ('3rd Floor', 3);

-- Floors (only the 2nd Floor existed). Matched by name, so nothing doubles.
INSERT INTO home_floors (id, name, position, created_at, updated_at)
SELECT lower(hex(randomblob(16))), f.name, f.pos, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _seed_floors f
WHERE NOT EXISTS (SELECT 1 FROM home_floors h WHERE lower(trim(h.name)) = lower(f.name));

UPDATE home_floors SET position = (SELECT f.pos FROM _seed_floors f WHERE lower(f.name) = lower(trim(home_floors.name)))
WHERE lower(trim(name)) IN (SELECT lower(name) FROM _seed_floors);

CREATE TABLE _seed_rooms (floor TEXT NOT NULL, name TEXT NOT NULL);
INSERT INTO _seed_rooms VALUES ('basement', 'Laundry Room');
INSERT INTO _seed_rooms VALUES ('basement', 'Boiler Room');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Mudroom');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Kitchen');
INSERT INTO _seed_rooms VALUES ('1st floor', '1st Floor Bathroom');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Living Room');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Dining Room');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Study');
INSERT INTO _seed_rooms VALUES ('1st floor', 'Foyer');
INSERT INTO _seed_rooms VALUES ('2nd floor', '2nd Floor Bathroom');
INSERT INTO _seed_rooms VALUES ('2nd floor', 'Office');
INSERT INTO _seed_rooms VALUES ('2nd floor', 'Chase''s Room');
INSERT INTO _seed_rooms VALUES ('2nd floor', 'Cady''s Room');
INSERT INTO _seed_rooms VALUES ('2nd floor', 'Master Bedroom');
INSERT INTO _seed_rooms VALUES ('2nd floor', 'Master Bedroom Closet');
INSERT INTO _seed_rooms VALUES ('3rd floor', 'Playroom');
INSERT INTO _seed_rooms VALUES ('3rd floor', 'Gym');
INSERT INTO _seed_rooms VALUES ('3rd floor', '3rd Floor Bathroom');
INSERT INTO _seed_rooms VALUES ('3rd floor', 'Attic');

-- Every room, unmeasured placeholders (120" × 120"); rooms that already exist
-- on that floor (same name, any case) are left alone.
INSERT INTO home_rooms (id, floor_id, name, x, y, width, depth, points, measured, created_at, updated_at)
SELECT lower(hex(randomblob(16))), fl.id, r.name, 0, 0, 120, 120,
       '[{"x":0,"y":0},{"x":120,"y":0},{"x":120,"y":120},{"x":0,"y":120}]', 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _seed_rooms r
JOIN home_floors fl ON lower(trim(fl.name)) = r.floor
WHERE NOT EXISTS (SELECT 1 FROM home_rooms x WHERE x.floor_id = fl.id AND lower(trim(x.name)) = lower(r.name));

DROP TABLE _seed_rooms;
DROP TABLE _seed_floors;
