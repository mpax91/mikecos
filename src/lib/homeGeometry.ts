// Rectilinear room-shape geometry for the Home floor canvas. A room's
// shape is a closed polygon of whole-inch points, every wall horizontal
// or vertical (see worker/migrations/0078_home_room_shapes.sql for why:
// covers L-shapes/notches/bump-outs without a freeform-angle editor).
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

export function wallSegment(points: Point[], wallIndex: number): { a: Point; b: Point; horizontal: boolean; length: number } {
  const a = points[wallIndex];
  const b = points[(wallIndex + 1) % points.length];
  const horizontal = a.y === b.y;
  const length = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  return { a, b, horizontal, length };
}

export function wallMidpoint(points: Point[], wallIndex: number): Point {
  const { a, b } = wallSegment(points, wallIndex);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The point on wall `wallIndex`, `offset` inches from its start corner
 * (a), toward its end corner (b) — this is where a door/window's own
 * start sits along the wall. */
export function pointAlongWall(points: Point[], wallIndex: number, offset: number): Point {
  const { a, b, horizontal } = wallSegment(points, wallIndex);
  const dir = horizontal ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1;
  return horizontal ? { x: a.x + dir * offset, y: a.y } : { x: a.x, y: a.y + dir * offset };
}

/** Inverse of pointAlongWall: given a raw point near wall `wallIndex`
 * (e.g. a click), the offset in inches along that wall closest to it,
 * clamped to the wall's own length. */
export function offsetOnWall(points: Point[], wallIndex: number, at: Point): number {
  const { a, b, horizontal, length } = wallSegment(points, wallIndex);
  const dir = horizontal ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1;
  const raw = horizontal ? (at.x - a.x) * dir : (at.y - a.y) * dir;
  return Math.max(0, Math.min(length, Math.round(raw)));
}

/** The unit normal pointing toward the room's centroid from the
 * midpoint of `wallIndex` — an approximation of "into the room" that
 * holds for the convex and mildly-notched shapes a house floor plan
 * actually produces, used to decide which way a door's swing arc opens
 * and which way a freshly-inserted notch defaults to leaning. */
export function inwardNormal(points: Point[], wallIndex: number): { nx: number; ny: number } {
  const { horizontal } = wallSegment(points, wallIndex);
  const mid = wallMidpoint(points, wallIndex);
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  if (horizontal) return { nx: 0, ny: cy >= mid.y ? 1 : -1 };
  return { nx: cx >= mid.x ? 1 : -1, ny: 0 };
}

/** Drags wall `wallIndex` perpendicular to itself by `delta` inches
 * (positive = along its inward normal). Both of the wall's own endpoints
 * move together, which lengthens/shortens the two neighboring walls;
 * nothing further around the polygon is touched. Clamped so neither
 * neighboring wall collapses below MIN_WALL_LENGTH. */
export function dragWall(points: Point[], wallIndex: number, delta: number): Point[] {
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
    const { a, b, horizontal, length } = wallSegment(newPoints, i);
    if (length === 0) continue;
    const t = horizontal ? Math.max(0, Math.min(1, (at.x - a.x) / (b.x - a.x))) : Math.max(0, Math.min(1, (at.y - a.y) / (b.y - a.y)));
    const projX = horizontal ? a.x + (b.x - a.x) * t : a.x;
    const projY = horizontal ? a.y : a.y + (b.y - a.y) * t;
    const dist = Math.hypot(at.x - projX, at.y - projY);
    if (dist < best.dist) best = { wallIndex: i, offset: offsetOnWall(newPoints, i, { x: projX, y: projY }), dist };
  }
  return { wallIndex: best.wallIndex, offset: best.offset };
}
