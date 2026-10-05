// Room-shape geometry for the Home floor canvas. A room's shape is a
// closed polygon of inch points. Rooms drawn on the canvas stay
// rectilinear (every wall horizontal or vertical); rooms imported from a
// spec (src/lib/roomSpec.ts) can have angled walls and curves (as short
// chords), which is why the helpers below work at any angle. Canvas
// reshaping stays rectilinear on purpose (see
// worker/migrations/0078_home_room_shapes.sql) — angled shapes come from
// a spec, not from freehand dragging.
// Points are always normalized so the shape's own bounding box has its
// top-left at (0,0) — room.x/room.y (unchanged from the rectangle-only
// version) is where that bounding box sits on the floor. This file is
// the only place that needs to understand polygon math; fixture
// placement, dragging, etc. still only ever deal with the bounding box.
//
// Reshaping is wall-based, not corner-based: you drag a wall
// perpendicular to itself, and both of ITS endpoints move together,
// which automatically shortens/lengthens the two walls on either side
// of it without touching anything further around the polygon. For a
// plain 4-wall rectangle this is exactly today's resize, just available
// from any of the 4 walls instead of one corner handle. A free "drag any
// corner in 2D" interaction was considered and dropped — on a polygon
// with more than 4 points it has no single well-defined meaning (which
// of a corner's two walls "owns" the move cascades ambiguously), where
// wall-dragging has one obvious, composable effect every time.

export interface Point {
  x: number;
  y: number;
}

export const MIN_WALL_LENGTH = 6; // inches — clamp so a drag can't collapse a wall to nothing
const NOTCH_DEPTH = 1; // inches — near-invisible initial jog a new corner starts at, so it's immediately draggable
const NOTCH_WIDTH = 24; // inches — default width of a freshly-inserted notch, before the user adjusts it

export function rectanglePoints(width: number, depth: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
}

export function boundingBox(points: Point[]): { minX: number; minY: number; width: number; depth: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, depth: Math.max(...ys) - minY };
}

/** Shifts points so their bounding box starts at (0,0), and returns the
 * shift that was applied (in inches) so the caller can move the room's
 * own x/y and every one of its fixtures by the same amount — keeping
 * everything visually anchored in place on the floor even though the
 * shape's local coordinate space just moved. */
export function normalizeShape(points: Point[]): { points: Point[]; dx: number; dy: number } {
  const { minX, minY } = boundingBox(points);
  if (minX === 0 && minY === 0) return { points, dx: 0, dy: 0 };
  return { points: points.map((p) => ({ x: p.x - minX, y: p.y - minY })), dx: minX, dy: minY };
}

export function polygonToSvgPoints(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** Walls within this many inches of level/plumb count as horizontal/
 * vertical — imported specs (src/lib/roomSpec.ts) produce decimal points
 * that can be a hair off true after closing a tape-measure gap. */
const AXIS_EPS = 0.5;

export function wallSegment(points: Point[], wallIndex: number): { a: Point; b: Point; horizontal: boolean; vertical: boolean; axisAligned: boolean; length: number; ux: number; uy: number } {
  const a = points[wallIndex];
  const b = points[(wallIndex + 1) % points.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const horizontal = Math.abs(dy) < AXIS_EPS;
  const vertical = !horizontal && Math.abs(dx) < AXIS_EPS;
  return { a, b, horizontal, vertical, axisAligned: horizontal || vertical, length, ux: length ? dx / length : 1, uy: length ? dy / length : 0 };
}

export function wallMidpoint(points: Point[], wallIndex: number): Point {
  const { a, b } = wallSegment(points, wallIndex);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The point on wall `wallIndex`, `offset` inches from its start corner
 * (a), toward its end corner (b) — this is where a door/window's own
 * start sits along the wall. Works for walls at any angle. */
export function pointAlongWall(points: Point[], wallIndex: number, offset: number): Point {
  const { a, ux, uy } = wallSegment(points, wallIndex);
  return { x: a.x + ux * offset, y: a.y + uy * offset };
}

/** Inverse of pointAlongWall: given a raw point near wall `wallIndex`
 * (e.g. a click), the offset in inches along that wall closest to it,
 * clamped to the wall's own length. */
export function offsetOnWall(points: Point[], wallIndex: number, at: Point): number {
  const { a, ux, uy, length } = wallSegment(points, wallIndex);
  const raw = (at.x - a.x) * ux + (at.y - a.y) * uy;
  return Math.max(0, Math.min(Math.floor(length), Math.round(raw)));
}

/** Twice the polygon's signed area — positive when the points run
 * clockwise on screen (y grows downward). */
function signedArea2(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/** The unit normal pointing into the room from wall `wallIndex`, from the
 * polygon's winding (room is on the right of a clockwise walk) — exact
 * for any simple polygon, including angled bays, curves and notches.
 * Used to decide which way a door's swing opens and which way a
 * freshly-inserted notch leans. */
export function inwardNormal(points: Point[], wallIndex: number): { nx: number; ny: number } {
  const { ux, uy } = wallSegment(points, wallIndex);
  return signedArea2(points) >= 0 ? { nx: -uy || 0, ny: ux || 0 } : { nx: uy || 0, ny: -ux || 0 };
}

/** Wall dragging only has one obvious meaning when the wall is level or
 * plumb and both neighbors run perpendicular to it (they stretch/shrink).
 * Angled bay walls and curve segments from an imported spec are reshaped
 * by re-importing the spec instead. */
export function canDragWall(points: Point[], wallIndex: number): boolean {
  const n = points.length;
  const seg = wallSegment(points, wallIndex);
  if (!seg.axisAligned) return false;
  const prev = wallSegment(points, (wallIndex - 1 + n) % n);
  const next = wallSegment(points, (wallIndex + 1) % n);
  return seg.horizontal ? prev.vertical && next.vertical : prev.horizontal && next.horizontal;
}

/** "+ Add Corner" (insertNotch) builds an axis-aligned notch, so it's only
 * offered on level/plumb walls. */
export function canAddCorner(points: Point[], wallIndex: number): boolean {
  return wallSegment(points, wallIndex).axisAligned;
}

/** Drags wall `wallIndex` perpendicular to itself by `delta` inches
 * (positive = along its inward normal). Both of the wall's own endpoints
 * move together, which lengthens/shortens the two neighboring walls;
 * nothing further around the polygon is touched. Clamped so neither
 * neighboring wall collapses below MIN_WALL_LENGTH. */
export function dragWall(points: Point[], wallIndex: number, delta: number): Point[] {
  if (!canDragWall(points, wallIndex)) return points;
  const n = points.length;
  const i = wallIndex;
  const j = (wallIndex + 1) % n;
  const prevI = (i - 1 + n) % n;
  const nextJ = (j + 1) % n;
  const { horizontal } = wallSegment(points, wallIndex);
  const { nx, ny } = inwardNormal(points, wallIndex);
  const sign = horizontal ? Math.sign(ny) || 1 : Math.sign(nx) || 1;
  const moveBy = delta * sign;

  // A conservative symmetric clamp rather than an exact directional bound
  // per wall (which flips depending on polygon winding and this wall's
  // orientation) — caps how far a single drag can push by the tighter of
  // the two neighboring walls' available slack, in either direction.
  // Slightly more conservative than the tightest valid move in some
  // cases, but it can never collapse a neighboring wall.
  const prevLen = horizontal ? Math.abs(points[i].y - points[prevI].y) : Math.abs(points[i].x - points[prevI].x);
  const nextLen = horizontal ? Math.abs(points[nextJ].y - points[j].y) : Math.abs(points[nextJ].x - points[j].x);
  const maxMove = Math.max(0, Math.min(prevLen, nextLen) - MIN_WALL_LENGTH);
  const clamped = Math.max(-maxMove, Math.min(maxMove, moveBy));

  const result = points.slice();
  if (horizontal) {
    result[i] = { ...points[i], y: points[i].y + clamped };
    result[j] = { ...points[j], y: points[j].y + clamped };
  } else {
    result[i] = { ...points[i], x: points[i].x + clamped };
    result[j] = { ...points[j], x: points[j].x + clamped };
  }
  return result;
}

/** Splits wall `wallIndex` into a short (1") notch centered at
 * `offsetAlongWall`, inserting 4 new points so the wall reads
 * a -> (wall) -> P1 -> (short perpendicular jog) -> P2 -> (short parallel
 * wall) -> P3 -> (short perpendicular jog back) -> P4 -> (wall) -> b.
 * Near-invisible the instant it's inserted, but now a real draggable
 * wall exists there — dragWall on the new middle segment is what turns
 * it into an actual notch or bump. This is the only way a rectangle
 * gains corners (dragWall alone can only reshape existing walls). */
export function insertNotch(points: Point[], wallIndex: number, offsetAlongWall: number): Point[] {
  if (!canAddCorner(points, wallIndex)) return points;
  const { a, b, horizontal, length } = wallSegment(points, wallIndex);
  const dir = horizontal ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1;
  const halfW = Math.min(NOTCH_WIDTH / 2, (length - 2 * MIN_WALL_LENGTH) / 2, offsetAlongWall - MIN_WALL_LENGTH, length - offsetAlongWall - MIN_WALL_LENGTH);
  const w = Math.max(MIN_WALL_LENGTH, halfW * 2);
  const start = Math.max(MIN_WALL_LENGTH, Math.min(length - MIN_WALL_LENGTH - w, offsetAlongWall - w / 2));

  const { nx, ny } = inwardNormal(points, wallIndex);
  const along = (o: number) => (horizontal ? { x: a.x + dir * o, y: a.y } : { x: a.x, y: a.y + dir * o });
  const p1 = along(start);
  const p4 = along(start + w);
  const p2 = horizontal ? { ...p1, y: p1.y + ny * NOTCH_DEPTH } : { ...p1, x: p1.x + nx * NOTCH_DEPTH };
  const p3 = horizontal ? { ...p4, y: p4.y + ny * NOTCH_DEPTH } : { ...p4, x: p4.x + nx * NOTCH_DEPTH };

  const result = points.slice();
  result.splice(wallIndex + 1, 0, { x: Math.round(p1.x), y: Math.round(p1.y) }, { x: Math.round(p2.x), y: Math.round(p2.y) }, { x: Math.round(p3.x), y: Math.round(p3.y) }, { x: Math.round(p4.x), y: Math.round(p4.y) });
  return result;
}

export function roomHasCustomShape(points: Point[]): boolean {
  return points.length > 4;
}

/** After a room's points change shape (a wall dragged, a notch inserted),
 * a door/window's (wallIndex, offset) can point at the wrong edge — a
 * notch splices new points into the array, shifting every later edge's
 * index, and a dragged neighbor wall changes its own length under an
 * item sitting on it. Rather than special-case each kind of edit,
 * re-anchor by geometry: find the old absolute point the item sat at,
 * then find whichever edge of the NEW polygon passes closest to it.
 * Works for any points change as long as `oldPoints` and `newPoints`
 * are in the same (untranslated) coordinate space — call this before
 * normalizeShape, since offsets are translation-invariant anyway. */
export function relocateAfterShapeChange(oldPoints: Point[], newPoints: Point[], wallIndex: number, offset: number): { wallIndex: number; offset: number } {
  const at = pointAlongWall(oldPoints, wallIndex, offset);
  let best = { wallIndex: 0, offset: 0, dist: Infinity };
  for (let i = 0; i < newPoints.length; i++) {
    const { a, length, ux, uy } = wallSegment(newPoints, i);
    if (length === 0) continue;
    const t = Math.max(0, Math.min(length, (at.x - a.x) * ux + (at.y - a.y) * uy));
    const projX = a.x + ux * t;
    const projY = a.y + uy * t;
    const dist = Math.hypot(at.x - projX, at.y - projY);
    if (dist < best.dist) best = { wallIndex: i, offset: offsetOnWall(newPoints, i, { x: projX, y: projY }), dist };
  }
  return { wallIndex: best.wallIndex, offset: best.offset };
}
