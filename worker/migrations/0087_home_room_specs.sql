-- Home v3: rooms imported from a room spec (src/lib/roomSpec.ts).
--
-- A room spec describes a room the way you measure it — walk the walls,
-- each wall's length and the turn at the next corner, curves as arcs —
-- and the frontend solves it into the same home_rooms.points polygon the
-- canvas already draws. Two consequences for the schema:
--
--   * points can now hold decimal inches and angled walls (an angled bay,
--     a quarter-round corner as short chords), not just the rectilinear
--     whole-inch polygons the canvas's own wall-dragging produces. The
--     column was always JSON text, so nothing changes structurally.
--   * spec keeps the original imported JSON, so exporting the room later
--     gives back the curves and wall names as written. It's cleared
--     whenever the shape is edited on the canvas (the stored spec would no
--     longer describe the room); export then derives straight walls from
--     the current points instead.
--
-- ceiling_height (inches) is the first real use of a room's third
-- dimension; nullable since canvas-drawn rooms never had one.

ALTER TABLE home_rooms ADD COLUMN ceiling_height INTEGER;
ALTER TABLE home_rooms ADD COLUMN spec TEXT;
