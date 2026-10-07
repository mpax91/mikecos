import { Hono } from 'hono';
import type { ElectricalBreakerRow, ElectricalPanelRow, Env, HomeFixtureRow, HomeFixtureType, HomeRoomRow, HomeFloorRow, HomeWallItemRow, HomeWallItemType } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Home — a to-scale digital floor plan. Mounted at /api/home.
 *
 * Floors > Rooms > Fixtures, plus a separate Electrical Panels/Breakers
 * domain that outlet/switch fixtures reference. See 0077_home.sql for the
 * full schema rationale — most importantly, every dimension is stored in
 * whole inches so the floor canvas the frontend draws is literally to
 * scale: a fixture's footprint really is proportional to the room it sits
 * in, which is what makes "will this couch fit" an answerable question
 * instead of a guess. A fixture's x/y is relative to its own room's
 * top-left corner (not the floor), so moving a room takes its fixtures
 * along for free — the frontend just adds room.x + fixture.x at render
 * time. */
export const homeRouter = new Hono<{ Bindings: Env }>();

function db(c: { env: Env }) {
  return c.env.DB;
}

const FIXTURE_TYPES: readonly HomeFixtureType[] = ['appliance', 'furniture', 'outlet', 'switch', 'fixture'];
function isFixtureType(v: unknown): v is HomeFixtureType {
  return typeof v === 'string' && (FIXTURE_TYPES as readonly string[]).includes(v);
}

const WALL_ITEM_TYPES: readonly HomeWallItemType[] = ['door', 'window'];
function isWallItemType(v: unknown): v is HomeWallItemType {
  return typeof v === 'string' && (WALL_ITEM_TYPES as readonly string[]).includes(v);
}

interface ShapePoint {
  x: number;
  y: number;
}

function rectanglePoints(width: number, depth: number): ShapePoint[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
}

// A room's points are the source of truth for its shape (see
// 0078_home_room_shapes.sql); width/depth stay in sync as their bounding
// box so every place that only cares about "roughly how big" (auto-
// placing a new room next to this one, a fixture's default stagger
// position) doesn't need to know polygon math at all.
function boundingBoxOf(points: ShapePoint[]): { width: number; depth: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  // ceil, not round: imported specs have decimal points, and the canvas
  // sizes the room's SVG to width/depth — rounding down would clip the
  // outermost wall by a fraction of an inch.
  return { width: Math.ceil(Math.max(...xs) - Math.min(...xs)), depth: Math.ceil(Math.max(...ys) - Math.min(...ys)) };
}

function validPoints(points: unknown): points is ShapePoint[] {
  return Array.isArray(points) && points.length >= 3 && points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

function parsePoints(raw: string | null, width: number, depth: number): ShapePoint[] {
  if (!raw) return rectanglePoints(width, depth);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 3) return parsed;
  } catch {
    // fall through to rectangle default
  }
  return rectanglePoints(width, depth);
}

function floorJson(r: HomeFloorRow) {
  return { id: r.id, name: r.name, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at };
}

function roomJson(r: HomeRoomRow) {
  return {
    id: r.id,
    floorId: r.floor_id,
    name: r.name,
    x: r.x,
    y: r.y,
    width: r.width,
    depth: r.depth,
    points: parsePoints(r.points, r.width, r.depth),
    ceilingHeight: r.ceiling_height ?? null,
    spec: r.spec ?? null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function wallItemJson(r: HomeWallItemRow & { vault_entry_title?: string | null }) {
  return {
    id: r.id,
    roomId: r.room_id,
    type: r.type,
    label: r.label,
    wallIndex: r.wall_index,
    offset: r.offset,
    width: r.width,
    swing: r.swing,
    vaultEntryId: r.vault_entry_id,
    vaultEntryTitle: r.vault_entry_title ?? null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// vaultEntryTitle/breakerLabel are joined in, not stored — a fixture's
// detail modal needs to show what it's linked to without a second round
// trip, and the canvas itself doesn't need them at all (only the list
// endpoints that feed the canvas + detail bother joining).
function fixtureJson(r: HomeFixtureRow & { vault_entry_title?: string | null; breaker_number?: string | null; breaker_label?: string | null }) {
  return {
    id: r.id,
    roomId: r.room_id,
    type: r.type,
    label: r.label,
    x: r.x,
    y: r.y,
    width: r.width,
    depth: r.depth,
    vaultEntryId: r.vault_entry_id,
    vaultEntryTitle: r.vault_entry_title ?? null,
    breakerId: r.breaker_id,
    breakerNumber: r.breaker_number ?? null,
    breakerLabel: r.breaker_label ?? null,
    smartDevice: r.smart_device === 1,
    smartNotes: r.smart_notes,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function panelJson(r: ElectricalPanelRow) {
  return { id: r.id, name: r.name, locationNotes: r.location_notes, createdAt: r.created_at, updatedAt: r.updated_at };
}

function breakerJson(r: ElectricalBreakerRow) {
  return { id: r.id, panelId: r.panel_id, number: r.number, label: r.label, amperage: r.amperage, createdAt: r.created_at, updatedAt: r.updated_at };
}

// ---- Floors ----

homeRouter.get('/floors', async (c) => {
  const { results } = await db(c).prepare('SELECT * FROM home_floors ORDER BY position ASC, created_at ASC').all<HomeFloorRow>();
  return c.json((results ?? []).map(floorJson));
});

homeRouter.post('/floors', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
  const id = uid();
  const ts = now();
  const maxPos = await db(c).prepare('SELECT COALESCE(MAX(position), -1) as m FROM home_floors').first<{ m: number }>();
  await db(c)
    .prepare('INSERT INTO home_floors (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, body.name.trim(), (maxPos?.m ?? -1) + 1, ts, ts)
    .run();
  const row = await db(c).prepare('SELECT * FROM home_floors WHERE id = ?').bind(id).first<HomeFloorRow>();
  return c.json(floorJson(row!), 201);
});

homeRouter.patch('/floors/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM home_floors WHERE id = ?').bind(id).first<HomeFloorRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ name?: string; position?: number }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.position !== undefined) {
    sets.push('position = ?');
    binds.push(body.position);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE home_floors SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM home_floors WHERE id = ?').bind(id).first<HomeFloorRow>();
  return c.json(floorJson(row!));
});

// Deletes the floor and everything on it — every room, every fixture in
// those rooms. Doesn't touch the linked Vault entries themselves (an
// appliance's purchase/manual record shouldn't vanish just because you
// deleted its map pin) or electrical panels (those aren't floor-scoped).
homeRouter.delete('/floors/:id', async (c) => {
  const id = c.req.param('id');
  await db(c).batch([
    db(c).prepare('DELETE FROM home_fixtures WHERE room_id IN (SELECT id FROM home_rooms WHERE floor_id = ?)').bind(id),
    db(c).prepare('DELETE FROM home_wall_items WHERE room_id IN (SELECT id FROM home_rooms WHERE floor_id = ?)').bind(id),
    db(c).prepare('DELETE FROM home_rooms WHERE floor_id = ?').bind(id),
    db(c).prepare('DELETE FROM home_floors WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- Rooms + fixtures for one floor (the canvas payload) ----

// GET /floors/:id/layout — everything the floor canvas needs in one round
// trip: the floor's rooms, and every fixture in those rooms (joined with
// its Vault title / breaker label so the canvas can show a badge without
// N follow-up requests).
homeRouter.get('/floors/:id/layout', async (c) => {
  const floorId = c.req.param('id');
  const floor = await db(c).prepare('SELECT * FROM home_floors WHERE id = ?').bind(floorId).first<HomeFloorRow>();
  if (!floor) return c.json({ error: 'not found' }, 404);
  const rooms = await db(c).prepare('SELECT * FROM home_rooms WHERE floor_id = ? ORDER BY created_at ASC').bind(floorId).all<HomeRoomRow>();
  const roomIds = (rooms.results ?? []).map((r) => r.id);
  let fixtures: ReturnType<typeof fixtureJson>[] = [];
  let wallItems: ReturnType<typeof wallItemJson>[] = [];
  if (roomIds.length) {
    const placeholders = roomIds.map(() => '?').join(', ');
    const { results } = await db(c)
      .prepare(
        `SELECT f.*, e.title as vault_entry_title, b.number as breaker_number, b.label as breaker_label
         FROM home_fixtures f
         LEFT JOIN entities e ON e.id = f.vault_entry_id
         LEFT JOIN electrical_breakers b ON b.id = f.breaker_id
         WHERE f.room_id IN (${placeholders})
         ORDER BY f.created_at ASC`
      )
      .bind(...roomIds)
      .all<HomeFixtureRow & { vault_entry_title: string | null; breaker_number: string | null; breaker_label: string | null }>();
    fixtures = (results ?? []).map(fixtureJson);

    const wallItemRows = await db(c)
      .prepare(
        `SELECT w.*, e.title as vault_entry_title
         FROM home_wall_items w
         LEFT JOIN entities e ON e.id = w.vault_entry_id
         WHERE w.room_id IN (${placeholders})
         ORDER BY w.created_at ASC`
      )
      .bind(...roomIds)
      .all<HomeWallItemRow & { vault_entry_title: string | null }>();
    wallItems = (wallItemRows.results ?? []).map(wallItemJson);
  }
  return c.json({ floor: floorJson(floor), rooms: (rooms.results ?? []).map(roomJson), fixtures, wallItems });
});

// ---- Rooms ----

interface RoomBody {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  depth?: number;
  points?: ShapePoint[];
  ceilingHeight?: number | null;
  notes?: string | null;
  floorId?: string; // PATCH only — moves the room to another floor
}

homeRouter.post('/floors/:floorId/rooms', async (c) => {
  const floorId = c.req.param('floorId');
  const floor = await db(c).prepare('SELECT id FROM home_floors WHERE id = ?').bind(floorId).first<{ id: string }>();
  if (!floor) return c.json({ error: 'floor not found' }, 404);
  const body = await c.req.json<RoomBody>();
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
  if (!body.width || body.width <= 0 || !body.depth || body.depth <= 0) return c.json({ error: 'width and depth (in inches) are required' }, 400);

  // A room always starts as a plain rectangle — its shape only becomes a
  // polygon once reshaped on the canvas (see HomeFloorCanvas / homeGeometry.ts).
  const points = rectanglePoints(Math.round(body.width), Math.round(body.depth));

  const id = uid();
  const ts = now();
  await db(c)
    .prepare('INSERT INTO home_rooms (id, floor_id, name, x, y, width, depth, points, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, floorId, body.name.trim(), Math.round(body.x ?? 0), Math.round(body.y ?? 0), Math.round(body.width), Math.round(body.depth), JSON.stringify(points), body.notes?.trim() || null, ts, ts)
    .run();
  const row = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  return c.json(roomJson(row!), 201);
});

homeRouter.patch('/rooms/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<RoomBody>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.x !== undefined) {
    sets.push('x = ?');
    binds.push(Math.round(body.x));
  }
  if (body.y !== undefined) {
    sets.push('y = ?');
    binds.push(Math.round(body.y));
  }
  if (body.points !== undefined) {
    // The canvas sends the reshaped polygon directly (wall drag, notch
    // insert) — width/depth are re-derived from it so every other query
    // that only reads the bounding box stays correct without the
    // frontend having to compute and send it separately.
    if (!validPoints(body.points)) return c.json({ error: 'points must have at least 3 {x,y} vertices' }, 400);
    const bbox = boundingBoxOf(body.points);
    // Any canvas reshape means the imported spec (if any) no longer
    // describes this room — drop it so export derives from the new shape.
    sets.push('points = ?', 'width = ?', 'depth = ?', 'spec = NULL');
    binds.push(JSON.stringify(body.points), bbox.width, bbox.depth);
  } else if (body.width !== undefined || body.depth !== undefined) {
    // Editing width/depth numerically (the room modal, for a still-simple
    // rectangle) regenerates points as a plain rectangle — this is only
    // meaningful for a room that hasn't been reshaped into a polygon yet.
    if (body.width !== undefined && body.width <= 0) return c.json({ error: 'width must be positive' }, 400);
    if (body.depth !== undefined && body.depth <= 0) return c.json({ error: 'depth must be positive' }, 400);
    const width = Math.round(body.width ?? existing.width);
    const depth = Math.round(body.depth ?? existing.depth);
    sets.push('width = ?', 'depth = ?', 'points = ?', 'spec = NULL');
    binds.push(width, depth, JSON.stringify(rectanglePoints(width, depth)));
  }
  if (body.ceilingHeight !== undefined) {
    sets.push('ceiling_height = ?');
    binds.push(body.ceilingHeight && body.ceilingHeight > 0 ? Math.round(body.ceilingHeight) : null);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (body.floorId !== undefined && body.floorId !== existing.floor_id) {
    const floor = await db(c).prepare('SELECT id FROM home_floors WHERE id = ?').bind(body.floorId).first<{ id: string }>();
    if (!floor) return c.json({ error: 'floor not found' }, 404);
    sets.push('floor_id = ?');
    binds.push(body.floorId);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE home_rooms SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  return c.json(roomJson(row!));
});

// ---- Room specs (src/lib/roomSpec.ts) ----
//
// The frontend solves a room spec into points + doors/windows (one solver,
// used for the live preview too); these endpoints just persist the result
// in one batch so a room never exists half-imported.

interface SpecWallItem {
  type?: string;
  label?: string;
  wallIndex?: number;
  offset?: number;
  width?: number;
  swing?: 'left' | 'right' | null;
  notes?: string | null;
}

interface SpecImportBody {
  name?: string;
  x?: number;
  y?: number;
  points?: ShapePoint[];
  ceilingHeight?: number | null;
  spec?: unknown;
  notes?: string | null;
  wallItems?: SpecWallItem[];
}

function checkSpecBody(body: SpecImportBody): string | null {
  if (!validPoints(body.points)) return 'points must have at least 3 {x,y} vertices';
  for (const w of body.wallItems ?? []) {
    if (!isWallItemType(w.type)) return `wall item type must be one of ${WALL_ITEM_TYPES.join(', ')}`;
    if (!w.label?.trim()) return 'every wall item needs a label';
    if (!Number.isInteger(w.wallIndex) || w.wallIndex! < 0 || w.wallIndex! >= body.points!.length) return `wall item "${w.label}" has an invalid wallIndex`;
  }
  return null;
}

function wallItemInserts(c: { env: Env }, roomId: string, items: SpecWallItem[], ts: string) {
  return items.map((w) =>
    db(c)
      .prepare(
        `INSERT INTO home_wall_items (id, room_id, type, label, wall_index, offset, width, swing, vault_entry_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(uid(), roomId, w.type, w.label!.trim(), w.wallIndex, Math.max(0, Math.round(w.offset ?? 0)), Math.max(1, Math.round(w.width ?? 30)), w.type === 'door' ? w.swing ?? 'left' : null, w.notes?.trim() || null, ts, ts)
  );
}

homeRouter.post('/floors/:floorId/rooms/import', async (c) => {
  const floorId = c.req.param('floorId');
  const floor = await db(c).prepare('SELECT id FROM home_floors WHERE id = ?').bind(floorId).first<{ id: string }>();
  if (!floor) return c.json({ error: 'floor not found' }, 404);
  const body = await c.req.json<SpecImportBody>();
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
  const problem = checkSpecBody(body);
  if (problem) return c.json({ error: problem }, 400);
  const bbox = boundingBoxOf(body.points!);
  const id = uid();
  const ts = now();
  await db(c).batch([
    db(c)
      .prepare('INSERT INTO home_rooms (id, floor_id, name, x, y, width, depth, points, ceiling_height, spec, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(
        id,
        floorId,
        body.name.trim(),
        Math.round(body.x ?? 0),
        Math.round(body.y ?? 0),
        bbox.width,
        bbox.depth,
        JSON.stringify(body.points),
        body.ceilingHeight && body.ceilingHeight > 0 ? Math.round(body.ceilingHeight) : null,
        body.spec ? JSON.stringify(body.spec) : null,
        body.notes?.trim() || null,
        ts,
        ts
      ),
    ...wallItemInserts(c, id, body.wallItems ?? [], ts),
  ]);
  const row = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  return c.json(roomJson(row!), 201);
});

/** Replace an existing room's shape (and its doors/windows) from a spec,
 * keeping the room itself — its id, position, fixtures and notes. */
homeRouter.post('/rooms/:id/reshape', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<SpecImportBody>();
  const problem = checkSpecBody(body);
  if (problem) return c.json({ error: problem }, 400);
  const bbox = boundingBoxOf(body.points!);
  const ts = now();
  await db(c).batch([
    db(c)
      .prepare('UPDATE home_rooms SET points = ?, width = ?, depth = ?, ceiling_height = ?, spec = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(body.points), bbox.width, bbox.depth, body.ceilingHeight && body.ceilingHeight > 0 ? Math.round(body.ceilingHeight) : existing.ceiling_height, body.spec ? JSON.stringify(body.spec) : null, ts, id),
    db(c).prepare('DELETE FROM home_wall_items WHERE room_id = ?').bind(id),
    ...wallItemInserts(c, id, body.wallItems ?? [], ts),
  ]);
  const row = await db(c).prepare('SELECT * FROM home_rooms WHERE id = ?').bind(id).first<HomeRoomRow>();
  return c.json(roomJson(row!));
});

homeRouter.delete('/rooms/:id', async (c) => {
  const id = c.req.param('id');
  await db(c).batch([
    db(c).prepare('DELETE FROM home_fixtures WHERE room_id = ?').bind(id),
    db(c).prepare('DELETE FROM home_wall_items WHERE room_id = ?').bind(id),
    db(c).prepare('DELETE FROM home_rooms WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- Wall items (doors/windows) ----

interface WallItemBody {
  type?: string;
  label?: string;
  wallIndex?: number;
  offset?: number;
  width?: number;
  swing?: 'left' | 'right' | null;
  vaultEntryId?: string | null;
  notes?: string | null;
}

async function wallItemWithJoin(c: { env: Env }, id: string) {
  return db(c)
    .prepare(`SELECT w.*, e.title as vault_entry_title FROM home_wall_items w LEFT JOIN entities e ON e.id = w.vault_entry_id WHERE w.id = ?`)
    .bind(id)
    .first<HomeWallItemRow & { vault_entry_title: string | null }>();
}

homeRouter.post('/rooms/:roomId/wall-items', async (c) => {
  const roomId = c.req.param('roomId');
  const room = await db(c).prepare('SELECT id FROM home_rooms WHERE id = ?').bind(roomId).first<{ id: string }>();
  if (!room) return c.json({ error: 'room not found' }, 404);
  const body = await c.req.json<WallItemBody>();
  if (!isWallItemType(body.type)) return c.json({ error: `type must be one of ${WALL_ITEM_TYPES.join(', ')}` }, 400);
  if (!body.label?.trim()) return c.json({ error: 'label is required' }, 400);

  const id = uid();
  const ts = now();
  await db(c)
    .prepare(
      `INSERT INTO home_wall_items (id, room_id, type, label, wall_index, offset, width, swing, vault_entry_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      roomId,
      body.type,
      body.label.trim(),
      Math.round(body.wallIndex ?? 0),
      Math.round(body.offset ?? 0),
      Math.round(body.width ?? 30),
      body.type === 'door' ? body.swing ?? 'left' : null,
      body.vaultEntryId || null,
      body.notes?.trim() || null,
      ts,
      ts
    )
    .run();
  const row = await wallItemWithJoin(c, id);
  return c.json(wallItemJson(row!), 201);
});

homeRouter.patch('/wall-items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM home_wall_items WHERE id = ?').bind(id).first<HomeWallItemRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<WallItemBody>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.label !== undefined) {
    if (!body.label.trim()) return c.json({ error: 'label cannot be blank' }, 400);
    sets.push('label = ?');
    binds.push(body.label.trim());
  }
  if (body.wallIndex !== undefined) {
    sets.push('wall_index = ?');
    binds.push(Math.round(body.wallIndex));
  }
  if (body.offset !== undefined) {
    sets.push('offset = ?');
    binds.push(Math.round(body.offset));
  }
  if (body.width !== undefined) {
    sets.push('width = ?');
    binds.push(Math.max(1, Math.round(body.width)));
  }
  if (body.swing !== undefined && existing.type === 'door') {
    sets.push('swing = ?');
    binds.push(body.swing ?? 'left');
  }
  if (body.vaultEntryId !== undefined) {
    sets.push('vault_entry_id = ?');
    binds.push(body.vaultEntryId || null);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE home_wall_items SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await wallItemWithJoin(c, id);
  return c.json(wallItemJson(row!));
});

homeRouter.delete('/wall-items/:id', async (c) => {
  await db(c).prepare('DELETE FROM home_wall_items WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Fixtures ----

interface FixtureBody {
  type?: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  depth?: number;
  vaultEntryId?: string | null;
  breakerId?: string | null;
  smartDevice?: boolean;
  smartNotes?: string | null;
  notes?: string | null;
}

async function fixtureWithJoins(c: { env: Env }, id: string) {
  return db(c)
    .prepare(
      `SELECT f.*, e.title as vault_entry_title, b.number as breaker_number, b.label as breaker_label
       FROM home_fixtures f
       LEFT JOIN entities e ON e.id = f.vault_entry_id
       LEFT JOIN electrical_breakers b ON b.id = f.breaker_id
       WHERE f.id = ?`
    )
    .bind(id)
    .first<HomeFixtureRow & { vault_entry_title: string | null; breaker_number: string | null; breaker_label: string | null }>();
}

homeRouter.post('/rooms/:roomId/fixtures', async (c) => {
  const roomId = c.req.param('roomId');
  const room = await db(c).prepare('SELECT id FROM home_rooms WHERE id = ?').bind(roomId).first<{ id: string }>();
  if (!room) return c.json({ error: 'room not found' }, 404);
  const body = await c.req.json<FixtureBody>();
  if (!isFixtureType(body.type)) return c.json({ error: `type must be one of ${FIXTURE_TYPES.join(', ')}` }, 400);
  if (!body.label?.trim()) return c.json({ error: 'label is required' }, 400);

  // Footprint types default to a reasonable placeholder size Mike will
  // resize once he's measured the real thing; point types (outlet/switch/
  // fixture) default small since they're symbols, not space-planning
  // objects — but every fixture stores width/depth either way, so the
  // canvas has exactly one rendering code path for all five types.
  const defaultSize = body.type === 'appliance' || body.type === 'furniture' ? 24 : 6;

  const id = uid();
  const ts = now();
  await db(c)
    .prepare(
      `INSERT INTO home_fixtures (id, room_id, type, label, x, y, width, depth, vault_entry_id, breaker_id, smart_device, smart_notes, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      roomId,
      body.type,
      body.label.trim(),
      Math.round(body.x ?? 0),
      Math.round(body.y ?? 0),
      Math.round(body.width ?? defaultSize),
      Math.round(body.depth ?? defaultSize),
      body.vaultEntryId || null,
      body.breakerId || null,
      body.smartDevice ? 1 : 0,
      body.smartNotes?.trim() || null,
      body.notes?.trim() || null,
      ts,
      ts
    )
    .run();
  const row = await fixtureWithJoins(c, id);
  return c.json(fixtureJson(row!), 201);
});

homeRouter.patch('/fixtures/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM home_fixtures WHERE id = ?').bind(id).first<HomeFixtureRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<FixtureBody>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.label !== undefined) {
    if (!body.label.trim()) return c.json({ error: 'label cannot be blank' }, 400);
    sets.push('label = ?');
    binds.push(body.label.trim());
  }
  if (body.x !== undefined) {
    sets.push('x = ?');
    binds.push(Math.round(body.x));
  }
  if (body.y !== undefined) {
    sets.push('y = ?');
    binds.push(Math.round(body.y));
  }
  if (body.width !== undefined) {
    sets.push('width = ?');
    binds.push(Math.max(1, Math.round(body.width)));
  }
  if (body.depth !== undefined) {
    sets.push('depth = ?');
    binds.push(Math.max(1, Math.round(body.depth)));
  }
  if (body.vaultEntryId !== undefined) {
    sets.push('vault_entry_id = ?');
    binds.push(body.vaultEntryId || null);
  }
  if (body.breakerId !== undefined) {
    sets.push('breaker_id = ?');
    binds.push(body.breakerId || null);
  }
  if (body.smartDevice !== undefined) {
    sets.push('smart_device = ?');
    binds.push(body.smartDevice ? 1 : 0);
  }
  if (body.smartNotes !== undefined) {
    sets.push('smart_notes = ?');
    binds.push(body.smartNotes?.trim() || null);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE home_fixtures SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await fixtureWithJoins(c, id);
  return c.json(fixtureJson(row!));
});

homeRouter.delete('/fixtures/:id', async (c) => {
  await db(c).prepare('DELETE FROM home_fixtures WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Electrical panels + breakers ----

homeRouter.get('/panels', async (c) => {
  const { results } = await db(c).prepare('SELECT * FROM electrical_panels ORDER BY created_at ASC').all<ElectricalPanelRow>();
  return c.json((results ?? []).map(panelJson));
});

homeRouter.post('/panels', async (c) => {
  const body = await c.req.json<{ name?: string; locationNotes?: string | null }>();
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
  const id = uid();
  const ts = now();
  await db(c)
    .prepare('INSERT INTO electrical_panels (id, name, location_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, body.name.trim(), body.locationNotes?.trim() || null, ts, ts)
    .run();
  const row = await db(c).prepare('SELECT * FROM electrical_panels WHERE id = ?').bind(id).first<ElectricalPanelRow>();
  return c.json(panelJson(row!), 201);
});

homeRouter.patch('/panels/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM electrical_panels WHERE id = ?').bind(id).first<ElectricalPanelRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ name?: string; locationNotes?: string | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.locationNotes !== undefined) {
    sets.push('location_notes = ?');
    binds.push(body.locationNotes?.trim() || null);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE electrical_panels SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM electrical_panels WHERE id = ?').bind(id).first<ElectricalPanelRow>();
  return c.json(panelJson(row!));
});

// Deletes the panel and its breakers; any fixture assigned to one of those
// breakers just falls back to unassigned (breaker_id set null) rather than
// being deleted itself — an outlet is still a real outlet even if you
// delete the panel record.
homeRouter.delete('/panels/:id', async (c) => {
  const id = c.req.param('id');
  await db(c).batch([
    db(c).prepare('UPDATE home_fixtures SET breaker_id = NULL WHERE breaker_id IN (SELECT id FROM electrical_breakers WHERE panel_id = ?)').bind(id),
    db(c).prepare('DELETE FROM electrical_breakers WHERE panel_id = ?').bind(id),
    db(c).prepare('DELETE FROM electrical_panels WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

homeRouter.post('/panels/:panelId/breakers', async (c) => {
  const panelId = c.req.param('panelId');
  const panel = await db(c).prepare('SELECT id FROM electrical_panels WHERE id = ?').bind(panelId).first<{ id: string }>();
  if (!panel) return c.json({ error: 'panel not found' }, 404);
  const body = await c.req.json<{ number?: string; label?: string | null; amperage?: number | null }>();
  if (!body.number?.trim()) return c.json({ error: 'number is required' }, 400);
  const id = uid();
  const ts = now();
  await db(c)
    .prepare('INSERT INTO electrical_breakers (id, panel_id, number, label, amperage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, panelId, body.number.trim(), body.label?.trim() || null, body.amperage ?? null, ts, ts)
    .run();
  const row = await db(c).prepare('SELECT * FROM electrical_breakers WHERE id = ?').bind(id).first<ElectricalBreakerRow>();
  return c.json(breakerJson(row!), 201);
});

homeRouter.patch('/breakers/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM electrical_breakers WHERE id = ?').bind(id).first<ElectricalBreakerRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ number?: string; label?: string | null; amperage?: number | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.number !== undefined) {
    if (!body.number.trim()) return c.json({ error: 'number cannot be blank' }, 400);
    sets.push('number = ?');
    binds.push(body.number.trim());
  }
  if (body.label !== undefined) {
    sets.push('label = ?');
    binds.push(body.label?.trim() || null);
  }
  if (body.amperage !== undefined) {
    sets.push('amperage = ?');
    binds.push(body.amperage ?? null);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE electrical_breakers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM electrical_breakers WHERE id = ?').bind(id).first<ElectricalBreakerRow>();
  return c.json(breakerJson(row!));
});

// Deleting a breaker un-assigns (not deletes) any fixture on it — same
// reasoning as deleting a panel.
homeRouter.delete('/breakers/:id', async (c) => {
  const id = c.req.param('id');
  await db(c).batch([
    db(c).prepare('UPDATE home_fixtures SET breaker_id = NULL WHERE breaker_id = ?').bind(id),
    db(c).prepare('DELETE FROM electrical_breakers WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// GET /panels/:id/breakers — a panel's breakers, each with the fixtures
// assigned to it (name + which room/floor) — the reverse lookup Mike asked
// for: "what's on breaker 14" before flipping it, not just "what breaker
// is this outlet on."
homeRouter.get('/panels/:id/breakers', async (c) => {
  const panelId = c.req.param('id');
  const breakers = await db(c).prepare('SELECT * FROM electrical_breakers WHERE panel_id = ? ORDER BY number ASC').bind(panelId).all<ElectricalBreakerRow>();
  const breakerIds = (breakers.results ?? []).map((b) => b.id);
  const fixturesByBreaker = new Map<string, { id: string; label: string; type: HomeFixtureType; roomName: string; floorName: string }[]>();
  if (breakerIds.length) {
    const placeholders = breakerIds.map(() => '?').join(', ');
    const { results } = await db(c)
      .prepare(
        `SELECT f.id, f.label, f.type, f.breaker_id, r.name as room_name, fl.name as floor_name
         FROM home_fixtures f
         JOIN home_rooms r ON r.id = f.room_id
         JOIN home_floors fl ON fl.id = r.floor_id
         WHERE f.breaker_id IN (${placeholders})`
      )
      .bind(...breakerIds)
      .all<{ id: string; label: string; type: HomeFixtureType; breaker_id: string; room_name: string; floor_name: string }>();
    for (const row of results ?? []) {
      const list = fixturesByBreaker.get(row.breaker_id) ?? [];
      list.push({ id: row.id, label: row.label, type: row.type, roomName: row.room_name, floorName: row.floor_name });
      fixturesByBreaker.set(row.breaker_id, list);
    }
  }
  return c.json((breakers.results ?? []).map((b) => ({ ...breakerJson(b), fixtures: fixturesByBreaker.get(b.id) ?? [] })));
});
