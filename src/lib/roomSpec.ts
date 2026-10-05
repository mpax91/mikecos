// Room specs: a portable JSON description of a room's real shape, written
// the way you'd measure it with a tape — start at a corner, walk the walls
// in order, note each wall's length and how far you turn at the next
// corner. solveRoomSpec() turns that into the polygon the Home canvas
// draws (src/lib/homeGeometry.ts), plus doors/windows mounted on the
// right edges. This is what lets an odd room (angled bay, rounded corner)
// be described exactly once — by hand, by Claude, or by any other AI from
// photos + measurements — instead of being approximated by dragging walls.
//
// Conventions (also documented in ROOM_SPEC_GUIDE below, which is what
// you'd hand to an AI):
//   - Walk the room CLOCKWISE as seen on the plan, so the room is always on
//     your RIGHT.
//   - `turn` is the turn at the corner AFTER that wall, in degrees.
//     Positive = turn right (an ordinary outside corner of the room is 90),
//     negative = turn left (an inside jog / bump-out).
//   - A curved wall is `{ "arc": { "radius": r, "sweep": deg } }` instead of
//     `length` — sweep follows the same sign rule as turn.
//   - Every turn and sweep together must add to 360 for a closed room.
//   - `start_heading` is the direction the first wall runs on the plan, in
//     degrees clockwise from "right" (0 = right, 90 = down, 180 = left,
//     270 = up). It only rotates the drawing.
//   - Openings sit on a wall by `offset` from that wall's START (the corner
//     you reached it from while walking clockwise), and `width` along it.
//
// Small tape-measure error is expected: if the walk ends within
// `close_tolerance` inches (default 4) of where it started, the gap is
// spread evenly around the whole perimeter so the room closes cleanly; a
// bigger gap is reported as an error naming how far off it is.

import type { Point } from './homeGeometry';

export const ROOM_SPEC_VERSION = 1;

export interface RoomSpecWall {
  id: string;
  length?: number;
  arc?: { radius: number; sweep: number };
  turn?: number;
  label?: string;
}

export interface RoomSpecOpening {
  wall: string;
  type: 'door' | 'window';
  offset: number;
  width: number;
  label?: string;
  hinge?: 'start' | 'end'; // doors: which end of the opening the hinges are on
  sill?: number; // windows: sill height off the floor
  height?: number;
  notes?: string;
}

export interface RoomSpec {
  mikeos_room_spec: number;
  name?: string;
  units?: 'in' | 'cm';
  ceiling_height?: number;
  start_heading?: number;
  close_tolerance?: number;
  walls: RoomSpecWall[];
  openings?: RoomSpecOpening[];
  notes?: string;
}

export interface SolvedWallItem {
  type: 'door' | 'window';
  label: string;
  wallIndex: number;
  offset: number;
  width: number;
  swing: 'left' | 'right' | null;
  notes: string | null;
}

export interface SolvedRoom {
  ok: boolean;
  errors: string[];
  warnings: string[];
  name: string | null;
  ceilingHeight: number | null;
  notes: string | null;
  /** Normalized so min x/y = 0 — same convention as HomeRoom.points. */
  points: Point[];
  width: number;
  depth: number;
  area: number; // square inches
  perimeter: number; // inches
  closureGap: number; // inches the raw walk missed closing by
  wallItems: SolvedWallItem[];
  /** For labeling: which polygon edges each spec wall became. */
  wallEdges: { id: string; label: string | null; edges: number[]; length: number }[];
  spec: RoomSpec | null;
}

const DEG = Math.PI / 180;
const ARC_STEP_DEG = 15; // one chord per 15° of curve — 6 chords for a quarter-round
const round1 = (n: number) => Math.round(n * 10) / 10;

function emptyResult(errors: string[]): SolvedRoom {
  return { ok: false, errors, warnings: [], name: null, ceilingHeight: null, notes: null, points: [], width: 0, depth: 0, area: 0, perimeter: 0, closureGap: 0, wallItems: [], wallEdges: [], spec: null };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Parses JSON text (tolerating a ```json fence around it, which is how
 * most AIs hand it back) and solves it. */
export function solveRoomSpecText(text: string): SolvedRoom {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  if (!trimmed) return emptyResult(['Paste a room spec to preview it.']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return emptyResult([`Not valid JSON: ${(e as Error).message}`]);
  }
  return solveRoomSpec(parsed);
}

export function solveRoomSpec(input: unknown): SolvedRoom {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== 'object') return emptyResult(['Spec must be a JSON object.']);
  const spec = input as RoomSpec;
  if (spec.mikeos_room_spec !== ROOM_SPEC_VERSION) warnings.push(`Expected "mikeos_room_spec": ${ROOM_SPEC_VERSION} — treating it as version ${ROOM_SPEC_VERSION}.`);
  if (!Array.isArray(spec.walls) || spec.walls.length < 3) return emptyResult(['"walls" must list at least 3 walls.']);

  const k = spec.units === 'cm' ? 1 / 2.54 : 1;
  if (spec.units && spec.units !== 'in' && spec.units !== 'cm') errors.push(`"units" must be "in" or "cm".`);

  // ---- validate walls ----
  const seen = new Set<string>();
  spec.walls.forEach((w, i) => {
    const where = `Wall ${w?.id ?? `#${i + 1}`}`;
    if (!w || typeof w !== 'object') return errors.push(`Wall #${i + 1} isn't an object.`);
    if (!w.id || typeof w.id !== 'string') errors.push(`Wall #${i + 1} needs an "id".`);
    else if (seen.has(w.id)) errors.push(`Wall id "${w.id}" is used twice.`);
    else seen.add(w.id);
    if (w.arc) {
      if (!isNum(w.arc.radius) || w.arc.radius <= 0) errors.push(`${where}: arc.radius must be a positive number.`);
      if (!isNum(w.arc.sweep) || w.arc.sweep === 0 || Math.abs(w.arc.sweep) > 180) errors.push(`${where}: arc.sweep must be between -180 and 180 (not 0).`);
    } else if (!isNum(w.length) || w.length <= 0) {
      errors.push(`${where}: needs a positive "length" (or an "arc").`);
    }
    if (w.turn !== undefined && (!isNum(w.turn) || Math.abs(w.turn) >= 180)) errors.push(`${where}: "turn" must be between -180 and 180.`);
    if (w.turn === undefined && i < spec.walls.length - 1) errors.push(`${where}: needs a "turn" for the corner after it.`);
  });
  if (errors.length) return { ...emptyResult(errors), warnings };

  const turnTotal = spec.walls.reduce((s, w, i) => s + (w.arc ? w.arc.sweep : 0) + (i === spec.walls.length - 1 && w.turn === undefined ? 0 : w.turn ?? 0), 0);
  const lastTurnMissing = spec.walls[spec.walls.length - 1].turn === undefined;
  if (!lastTurnMissing && Math.abs(turnTotal - 360) > 2) {
    errors.push(`Turns add up to ${round1(turnTotal)}° — walking clockwise around a closed room they should total 360°. Check the signs (right = positive) and the corner angles.`);
  }

  // ---- walk the walls ----
  interface Seg {
    wallId: string;
    startOffset: number; // along the spec wall
    length: number;
  }
  let heading = (isNum(spec.start_heading) ? spec.start_heading : 0) * DEG;
  let pos: Point = { x: 0, y: 0 };
  const raw: Point[] = [pos];
  const segs: Seg[] = [];
  const wallLength = new Map<string, number>();
  for (const w of spec.walls) {
    if (w.arc) {
      const r = w.arc.radius * k;
      const n = Math.max(2, Math.ceil(Math.abs(w.arc.sweep) / ARC_STEP_DEG));
      const step = (w.arc.sweep / n) * DEG;
      const chord = 2 * r * Math.sin(Math.abs(step) / 2);
      const arcLen = (r * Math.abs(w.arc.sweep) * DEG) / n;
      for (let s = 0; s < n; s++) {
        heading += step / 2;
        pos = { x: pos.x + chord * Math.cos(heading), y: pos.y + chord * Math.sin(heading) };
        heading += step / 2;
        raw.push(pos);
        segs.push({ wallId: w.id, startOffset: s * arcLen, length: arcLen });
      }
      wallLength.set(w.id, r * Math.abs(w.arc.sweep) * DEG);
    } else {
      const len = w.length! * k;
      pos = { x: pos.x + len * Math.cos(heading), y: pos.y + len * Math.sin(heading) };
      raw.push(pos);
      segs.push({ wallId: w.id, startOffset: 0, length: len });
      wallLength.set(w.id, len);
    }
    heading += (w.turn ?? 0) * DEG;
  }

  // ---- close the loop ----
  const end = raw[raw.length - 1];
  const gap = Math.hypot(end.x, end.y);
  const tolerance = isNum(spec.close_tolerance) ? spec.close_tolerance : 4;
  if (gap > tolerance) {
    errors.push(`The walls don't meet back at the starting corner — they miss by ${round1(gap)}". Usually one wall length or corner angle is off.`);
  } else if (gap > 0.25) {
    warnings.push(`Walls missed closing by ${round1(gap)}" — spread evenly around the room to close it.`);
  }
  const total = segs.reduce((s, g) => s + g.length, 0);
  let along = 0;
  const closed: Point[] = raw.slice(0, -1).map((p, i) => {
    if (i > 0) along += segs[i - 1].length;
    const t = along / total;
    return { x: p.x - end.x * t, y: p.y - end.y * t };
  });

  // ---- normalize ----
  const minX = Math.min(...closed.map((p) => p.x));
  const minY = Math.min(...closed.map((p) => p.y));
  const points = closed.map((p) => ({ x: round1(p.x - minX), y: round1(p.y - minY) }));
  const width = Math.ceil(Math.max(...points.map((p) => p.x)));
  const depth = Math.ceil(Math.max(...points.map((p) => p.y)));

  if (selfIntersects(points)) errors.push('The walls cross each other — check the turn directions (right = positive, left = negative).');

  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  if (area2 < 0) warnings.push('The walls go counter-clockwise — that works, but a clockwise walk (room on your right) is the convention.');

  // ---- openings ----
  const wallItems: SolvedWallItem[] = [];
  for (const [i, o] of (spec.openings ?? []).entries()) {
    const where = `Opening ${o?.label ?? `#${i + 1}`}`;
    if (!o || (o.type !== 'door' && o.type !== 'window')) {
      errors.push(`${where}: "type" must be "door" or "window".`);
      continue;
    }
    if (!wallLength.has(o.wall)) {
      errors.push(`${where}: wall "${o.wall}" doesn't exist.`);
      continue;
    }
    if (!isNum(o.offset) || o.offset < 0 || !isNum(o.width) || o.width <= 0) {
      errors.push(`${where}: needs a non-negative "offset" and positive "width".`);
      continue;
    }
    const off = o.offset * k;
    const wid = o.width * k;
    const len = wallLength.get(o.wall)!;
    if (off + wid > len + 1) warnings.push(`${where}: runs ${round1(off + wid - len)}" past the end of wall ${o.wall}.`);
    const wallSegIdx = segs.map((s, idx) => ({ s, idx })).filter(({ s }) => s.wallId === o.wall);
    const hit = wallSegIdx.find(({ s }) => off < s.startOffset + s.length) ?? wallSegIdx[wallSegIdx.length - 1];
    const notesBits = [o.sill !== undefined ? `Sill ${round1(o.sill * k)}"` : null, o.height !== undefined ? `Height ${round1(o.height * k)}"` : null, o.notes ?? null].filter(Boolean);
    wallItems.push({
      type: o.type,
      label: o.label?.trim() || (o.type === 'door' ? 'Door' : 'Window'),
      wallIndex: hit.idx,
      offset: Math.max(0, Math.round(off - hit.s.startOffset)),
      width: Math.round(wid),
      swing: o.type === 'door' ? (o.hinge === 'end' ? 'right' : 'left') : null,
      notes: notesBits.length ? notesBits.join(' · ') : null,
    });
  }

  const wallEdges = spec.walls.map((w) => ({
    id: w.id,
    label: w.label ?? null,
    edges: segs.map((s, idx) => (s.wallId === w.id ? idx : -1)).filter((x) => x >= 0),
    length: round1(wallLength.get(w.id) ?? 0),
  }));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    name: spec.name?.trim() || null,
    ceilingHeight: isNum(spec.ceiling_height) ? Math.round(spec.ceiling_height * k) : null,
    notes: spec.notes?.trim() || null,
    points,
    width,
    depth,
    area: Math.abs(area2) / 2,
    perimeter: total,
    closureGap: gap,
    wallItems,
    wallEdges,
    spec,
  };
}

function selfIntersects(pts: Point[]): boolean {
  const n = pts.length;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent via wraparound
      const b1 = pts[j];
      const b2 = pts[(j + 1) % n];
      const d1 = cross(b1, b2, a1);
      const d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1);
      const d4 = cross(a1, a2, b2);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

/** The reverse direction: a room that's already on the canvas, written
 * back out as a spec (to hand to an AI, or to tweak and re-import). Uses
 * the originally-imported spec when the room's shape hasn't been edited
 * since — that keeps curves as curves and the original wall names —
 * otherwise derives straight walls W1..Wn from the current polygon. */
export function specFromRoom(
  room: { name: string; points: Point[]; ceilingHeight?: number | null; spec?: string | null; notes?: string | null },
  wallItems: { type: 'door' | 'window'; label: string; wallIndex: number; offset: number; width: number; swing: 'left' | 'right' | null; notes: string | null }[]
): RoomSpec {
  if (room.spec) {
    try {
      const stored = JSON.parse(room.spec) as RoomSpec;
      if (stored && Array.isArray(stored.walls)) return { ...stored, name: room.name };
    } catch {
      // fall through to deriving from points
    }
  }
  const pts = room.points;
  const n = pts.length;
  const headingOf = (i: number) => Math.atan2(pts[(i + 1) % n].y - pts[i].y, pts[(i + 1) % n].x - pts[i].x) / DEG;
  const walls: RoomSpecWall[] = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    let turn = headingOf((i + 1) % n) - headingOf(i);
    while (turn > 180) turn -= 360;
    while (turn <= -180) turn += 360;
    return { id: `W${i + 1}`, length: round1(Math.hypot(q.x - p.x, q.y - p.y)), turn: round1(turn) };
  });
  return {
    mikeos_room_spec: ROOM_SPEC_VERSION,
    name: room.name,
    units: 'in',
    ceiling_height: room.ceilingHeight ?? undefined,
    start_heading: round1(headingOf(0)),
    walls,
    openings: wallItems.map((w) => ({
      wall: `W${w.wallIndex + 1}`,
      type: w.type,
      offset: w.offset,
      width: w.width,
      label: w.label,
      ...(w.type === 'door' ? { hinge: w.swing === 'right' ? ('end' as const) : ('start' as const) } : {}),
      ...(w.notes ? { notes: w.notes } : {}),
    })),
    ...(room.notes ? { notes: room.notes } : {}),
  };
}

/** The instructions to hand an AI (ChatGPT, Claude, …) along with photos
 * and tape measurements, so what it returns imports cleanly. */
export const ROOM_SPEC_GUIDE = `Produce a MikeOS room spec (JSON only, no commentary) for the room I describe. Ask me for any measurement you don't have instead of guessing.

Format:
{
  "mikeos_room_spec": 1,
  "name": "Room name",
  "units": "in",
  "ceiling_height": 96,
  "start_heading": 0,
  "walls": [
    { "id": "A", "length": 144, "turn": 90, "label": "Headboard wall" },
    { "id": "B", "arc": { "radius": 16, "sweep": -90 }, "turn": 0, "label": "Rounded corner" }
  ],
  "openings": [
    { "wall": "A", "type": "window", "offset": 30, "width": 36, "sill": 24, "height": 54, "label": "Window" },
    { "wall": "A", "type": "door", "offset": 90, "width": 32, "hinge": "start", "label": "Entry" }
  ],
  "notes": "Anything else worth remembering"
}

Rules:
- Walk the room CLOCKWISE on the floor plan (room always on your right), starting at any corner. List every straight run as its own wall, including short jogs and angled bay walls.
- "length" is the wall's length in inches, corner to corner at the floor.
- "turn" is how far you turn at the corner AFTER that wall: positive = right (a normal corner is 90, a bay-window corner is usually 45), negative = left (a jog that sticks into the room).
- A curved wall uses "arc" instead of "length": "radius" in inches and "sweep" in degrees (same sign rule as turn).
- All turns plus all arc sweeps must add up to exactly 360.
- "start_heading" rotates the drawing: the direction the first wall runs on the plan (0 = right, 90 = down, 180 = left, 270 = up).
- Openings: "offset" is inches from the START of that wall (the corner you arrived from) to the edge of the opening's trim; "width" is outside of trim. Doors get "hinge": "start" or "end" (which end of the opening the hinges are on). Windows may include "sill" and "height".`;
