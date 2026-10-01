import { Hono } from 'hono';
import type { BarItemRow, BarItemType, BarTastingRow, Env } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const TYPES: readonly BarItemType[] = ['spirit', 'wine', 'beer'];
function isType(v: unknown): v is BarItemType {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v);
}

// See migrations/0076_bar_photos.sql — the editor detects this from the
// uploaded photo's own pixel dimensions, same pattern as Wallet card art
// (worker/src/wallet.ts), Mike never picks it.
const ART_ORIENTATIONS = ['landscape', 'portrait'] as const;
type ArtOrientation = (typeof ART_ORIENTATIONS)[number];
function normalizeOrientation(v: unknown, fallback: ArtOrientation): ArtOrientation {
  return (ART_ORIENTATIONS as readonly string[]).includes(v as string) ? (v as ArtOrientation) : fallback;
}

/** The Bar — home spirits/wine/beer inventory plus a Vivino/Untappd-style
 * tasting log. Mounted at /api/bar. See 0075_bar.sql for the two-table
 * shape (bar_items = the thing you own/track, bar_tastings = each time you
 * drank and scored one, kept independent so a score survives the bottle
 * going to zero). */
export const barRouter = new Hono<{ Bindings: Env }>();

function db(c: { env: Env }) {
  return c.env.DB;
}

function itemJson(r: BarItemRow) {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    category: r.category,
    producer: r.producer,
    vintage: r.vintage,
    region: r.region,
    color: r.color,
    geo: r.geo,
    quantity: r.quantity,
    drinkWindowStart: r.drink_window_start,
    drinkWindowEnd: r.drink_window_end,
    notes: r.notes,
    price: r.price,
    source: r.source,
    photoKey: r.photo_key,
    photoOrientation: r.photo_orientation,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function tastingJson(r: BarTastingRow) {
  let tags: string[] = [];
  try {
    tags = r.tags ? (JSON.parse(r.tags) as string[]) : [];
  } catch {
    tags = [];
  }
  return {
    id: r.id,
    itemId: r.item_id,
    consumedAt: r.consumed_at,
    score: r.score,
    tags,
    notes: r.notes,
    buyAgain: r.buy_again === null ? null : r.buy_again === 1,
    createdAt: r.created_at,
  };
}

// ---- Items ----

// GET /items?type=&q= — q matches name/producer/category/region.
barRouter.get('/items', async (c) => {
  const type = c.req.query('type');
  const q = c.req.query('q')?.trim();
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (isType(type)) {
    clauses.push('type = ?');
    binds.push(type);
  }
  if (q) {
    clauses.push('(name LIKE ? OR producer LIKE ? OR category LIKE ? OR region LIKE ? OR color LIKE ? OR geo LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await db(c)
    .prepare(`SELECT * FROM bar_items ${where} ORDER BY type, name COLLATE NOCASE ASC`)
    .bind(...binds)
    .all<BarItemRow>();
  return c.json((results ?? []).map(itemJson));
});

barRouter.get('/items/:id', async (c) => {
  const id = c.req.param('id');
  const row = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const tastings = await db(c)
    .prepare('SELECT * FROM bar_tastings WHERE item_id = ? ORDER BY consumed_at DESC, created_at DESC')
    .bind(id)
    .all<BarTastingRow>();
  return c.json({ ...itemJson(row), tastings: (tastings.results ?? []).map(tastingJson) });
});

interface ItemBody {
  type?: string;
  name?: string;
  category?: string | null;
  producer?: string | null;
  vintage?: number | null;
  region?: string | null;
  color?: string | null;
  geo?: string | null;
  quantity?: number;
  drinkWindowStart?: number | null;
  drinkWindowEnd?: number | null;
  notes?: string | null;
  price?: number | null;
  source?: string | null;
  photoKey?: string | null;
  photoMime?: string | null;
  photoOrientation?: string;
}

barRouter.post('/items', async (c) => {
  const body = await c.req.json<ItemBody>();
  if (!isType(body.type)) return c.json({ error: `type must be one of ${TYPES.join(', ')}` }, 400);
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  const id = uid();
  const ts = now();
  const quantity = Number.isFinite(body.quantity) ? Math.max(0, Math.trunc(body.quantity as number)) : 1;
  const photoOrientation = normalizeOrientation(body.photoOrientation, 'portrait');

  await db(c)
    .prepare(
      `INSERT INTO bar_items (id, type, name, category, producer, vintage, region, color, geo, quantity, drink_window_start, drink_window_end, notes, price, source, photo_key, photo_mime, photo_orientation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      body.type,
      body.name.trim(),
      body.category?.trim() || null,
      body.producer?.trim() || null,
      body.vintage ?? null,
      body.region?.trim() || null,
      body.color?.trim() || null,
      body.geo?.trim() || null,
      quantity,
      body.drinkWindowStart ?? null,
      body.drinkWindowEnd ?? null,
      body.notes?.trim() || null,
      body.price ?? null,
      body.source?.trim() || null,
      body.photoKey || null,
      body.photoMime || null,
      photoOrientation,
      ts,
      ts
    )
    .run();

  const row = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  return c.json(itemJson(row!), 201);
});

const BULK_CHUNK_SIZE = 100; // stays well under D1's per-batch statement cap

// POST /items/bulk — { type, rows: [{ name, category? }] }, one type applied
// to the whole batch. The "get the 20 spirits and current wine rack in
// without typing each one" path — mirrors the Media Catalog's bulk import.
barRouter.post('/items/bulk', async (c) => {
  const body = await c.req.json<{ type?: string; rows?: { name?: string; category?: string | null }[] }>();
  if (!isType(body.type)) return c.json({ error: `type must be one of ${TYPES.join(', ')}` }, 400);
  const rows = (body.rows ?? []).map((r) => ({ name: r.name?.trim() ?? '', category: r.category?.trim() || null })).filter((r) => r.name);
  if (rows.length === 0) return c.json({ error: 'rows is required' }, 400);

  const ts = now();
  const toInsert = rows.map((r) => ({ id: uid(), ...r }));
  for (let i = 0; i < toInsert.length; i += BULK_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + BULK_CHUNK_SIZE);
    await db(c).batch(
      chunk.map((r) =>
        db(c)
          .prepare(
            `INSERT INTO bar_items (id, type, name, category, producer, vintage, region, quantity, drink_window_start, drink_window_end, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, NULL, NULL, NULL, ?, ?)`
          )
          .bind(r.id, body.type, r.name, r.category, ts, ts)
      )
    );
  }
  return c.json({ created: toInsert.length }, 201);
});

barRouter.patch('/items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<ItemBody>();

  // Delete the old R2 object when the photo is replaced or removed — same
  // orphan-avoidance as wallet.ts's cover/back art replace logic.
  if (body.photoKey !== undefined && existing.photo_key && existing.photo_key !== body.photoKey) {
    await c.env.FILES.delete(existing.photo_key).catch(() => {});
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.category !== undefined) {
    sets.push('category = ?');
    binds.push(body.category?.trim() || null);
  }
  if (body.producer !== undefined) {
    sets.push('producer = ?');
    binds.push(body.producer?.trim() || null);
  }
  if (body.vintage !== undefined) {
    sets.push('vintage = ?');
    binds.push(body.vintage ?? null);
  }
  if (body.region !== undefined) {
    sets.push('region = ?');
    binds.push(body.region?.trim() || null);
  }
  if (body.color !== undefined) {
    sets.push('color = ?');
    binds.push(body.color?.trim() || null);
  }
  if (body.geo !== undefined) {
    sets.push('geo = ?');
    binds.push(body.geo?.trim() || null);
  }
  if (body.quantity !== undefined) {
    sets.push('quantity = ?');
    binds.push(Math.max(0, Math.trunc(body.quantity)));
  }
  if (body.drinkWindowStart !== undefined) {
    sets.push('drink_window_start = ?');
    binds.push(body.drinkWindowStart ?? null);
  }
  if (body.drinkWindowEnd !== undefined) {
    sets.push('drink_window_end = ?');
    binds.push(body.drinkWindowEnd ?? null);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (body.price !== undefined) {
    sets.push('price = ?');
    binds.push(body.price ?? null);
  }
  if (body.source !== undefined) {
    sets.push('source = ?');
    binds.push(body.source?.trim() || null);
  }
  if (body.photoKey !== undefined) {
    sets.push('photo_key = ?');
    binds.push(body.photoKey || null);
  }
  if (body.photoMime !== undefined) {
    sets.push('photo_mime = ?');
    binds.push(body.photoMime || null);
  }
  if (body.photoOrientation !== undefined) {
    sets.push('photo_orientation = ?');
    binds.push(normalizeOrientation(body.photoOrientation, existing.photo_orientation as ArtOrientation));
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), id);
    await db(c).prepare(`UPDATE bar_items SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  return c.json(itemJson(row!));
});

// POST /items/:id/quantity — { delta: number } — the +/- stepper. Clamped
// at 0 rather than allowed negative; deleting the item itself (not just
// zeroing it) is a separate, deliberate action so a wine's tasting history
// stays around after the last bottle's gone.
barRouter.post('/items/:id/quantity', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ delta?: number }>();
  const delta = Number.isFinite(body.delta) ? Math.trunc(body.delta as number) : 0;
  const quantity = Math.max(0, existing.quantity + delta);
  await db(c).prepare('UPDATE bar_items SET quantity = ?, updated_at = ? WHERE id = ?').bind(quantity, now(), id).run();
  const row = await db(c).prepare('SELECT * FROM bar_items WHERE id = ?').bind(id).first<BarItemRow>();
  return c.json(itemJson(row!));
});

barRouter.delete('/items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT photo_key FROM bar_items WHERE id = ?').bind(id).first<{ photo_key: string | null }>();
  if (existing?.photo_key) await c.env.FILES.delete(existing.photo_key).catch(() => {});
  await db(c).batch([
    db(c).prepare('DELETE FROM bar_tastings WHERE item_id = ?').bind(id),
    db(c).prepare('DELETE FROM bar_items WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- Tastings ----

interface TastingBody {
  consumedAt?: string | null;
  score?: number | null;
  tags?: string[];
  notes?: string | null;
  buyAgain?: boolean | null;
}

barRouter.get('/items/:id/tastings', async (c) => {
  const rows = await db(c)
    .prepare('SELECT * FROM bar_tastings WHERE item_id = ? ORDER BY consumed_at DESC, created_at DESC')
    .bind(c.req.param('id'))
    .all<BarTastingRow>();
  return c.json((rows.results ?? []).map(tastingJson));
});

barRouter.post('/items/:id/tastings', async (c) => {
  const itemId = c.req.param('id');
  const item = await db(c).prepare('SELECT id FROM bar_items WHERE id = ?').bind(itemId).first<{ id: string }>();
  if (!item) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<TastingBody>();
  const id = uid();
  const ts = now();
  await db(c)
    .prepare('INSERT INTO bar_tastings (id, item_id, consumed_at, score, tags, notes, buy_again, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      itemId,
      body.consumedAt || null,
      body.score ?? null,
      JSON.stringify(body.tags ?? []),
      body.notes?.trim() || null,
      body.buyAgain === undefined || body.buyAgain === null ? null : body.buyAgain ? 1 : 0,
      ts
    )
    .run();
  const row = await db(c).prepare('SELECT * FROM bar_tastings WHERE id = ?').bind(id).first<BarTastingRow>();
  return c.json(tastingJson(row!), 201);
});

barRouter.patch('/tastings/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT * FROM bar_tastings WHERE id = ?').bind(id).first<BarTastingRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<TastingBody>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.consumedAt !== undefined) {
    sets.push('consumed_at = ?');
    binds.push(body.consumedAt || null);
  }
  if (body.score !== undefined) {
    sets.push('score = ?');
    binds.push(body.score ?? null);
  }
  if (body.tags !== undefined) {
    sets.push('tags = ?');
    binds.push(JSON.stringify(body.tags ?? []));
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (body.buyAgain !== undefined) {
    sets.push('buy_again = ?');
    binds.push(body.buyAgain === null ? null : body.buyAgain ? 1 : 0);
  }
  if (sets.length) {
    binds.push(id);
    await db(c).prepare(`UPDATE bar_tastings SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const row = await db(c).prepare('SELECT * FROM bar_tastings WHERE id = ?').bind(id).first<BarTastingRow>();
  return c.json(tastingJson(row!));
});

barRouter.delete('/tastings/:id', async (c) => {
  await db(c).prepare('DELETE FROM bar_tastings WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// GET /tastings/top?type=&limit= — every scored tasting (any item, in or
// out of stock), highest score first — the "what did I actually like"
// shopping-reference list. One row per tasting, not deduped per item, so
// tasting the same wine across two vintages/occasions shows both.
barRouter.get('/tastings/top', async (c) => {
  const type = c.req.query('type');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const clauses = ['bt.score IS NOT NULL'];
  const binds: unknown[] = [];
  if (isType(type)) {
    clauses.push('bi.type = ?');
    binds.push(type);
  }
  const { results } = await db(c)
    .prepare(
      `SELECT bt.*, bi.name as item_name, bi.type as item_type, bi.category as item_category, bi.producer as item_producer,
              bi.vintage as item_vintage, bi.region as item_region, bi.color as item_color, bi.geo as item_geo, bi.quantity as item_quantity
       FROM bar_tastings bt
       JOIN bar_items bi ON bi.id = bt.item_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY bt.score DESC, bt.consumed_at DESC
       LIMIT ?`
    )
    .bind(...binds, limit)
    .all<
      BarTastingRow & {
        item_name: string;
        item_type: BarItemType;
        item_category: string | null;
        item_producer: string | null;
        item_vintage: number | null;
        item_region: string | null;
        item_color: string | null;
        item_geo: string | null;
        item_quantity: number;
      }
    >();

  return c.json(
    (results ?? []).map((r) => ({
      ...tastingJson(r),
      item: {
        id: r.item_id,
        name: r.item_name,
        type: r.item_type,
        category: r.item_category,
        producer: r.item_producer,
        vintage: r.item_vintage,
        region: r.item_region,
        color: r.item_color,
        geo: r.item_geo,
        quantity: r.item_quantity,
      },
    }))
  );
});
