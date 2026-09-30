import { Hono } from 'hono';
import type { Env } from './types';

/** Hand-entered physical/digital media catalog — see migrations/0073.
 * Mounted at /api/media alongside the Plex mirror (mounted at /api/plex),
 * which together make up the Media section's "Plex vs Physical vs
 * Digital" three-source model. Deliberately tiny: title/author/format/
 * notes, nothing else — this is a catalog, not a tracker. */
export const mediaCatalogRouter = new Hono<{ Bindings: Env }>();

const FORMATS = ['physical_book', 'ebook', 'audiobook'] as const;
type MediaFormat = (typeof FORMATS)[number];

function isFormat(v: unknown): v is MediaFormat {
  return typeof v === 'string' && (FORMATS as readonly string[]).includes(v);
}

/** physical_book -> physical; ebook/audiobook -> digital — the two-way
 * split the Media section's filter chips actually show Mike, derived
 * from format rather than stored separately so the two can never drift
 * out of sync with each other. */
export function sourceForFormat(format: MediaFormat): 'physical' | 'digital' {
  return format === 'physical_book' ? 'physical' : 'digital';
}

interface MediaItemRow {
  id: string;
  title: string;
  author: string | null;
  format: MediaFormat;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function itemJson(r: MediaItemRow) {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    format: r.format,
    source: sourceForFormat(r.format),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /items?q=&format= — format is a single value from FORMATS, or
// 'physical'/'digital' to match either side of the split.
mediaCatalogRouter.get('/items', async (c) => {
  const q = c.req.query('q')?.trim();
  const formatParam = c.req.query('format')?.trim();

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    clauses.push('(title LIKE ? OR author LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (formatParam === 'physical') {
    clauses.push(`format = 'physical_book'`);
  } else if (formatParam === 'digital') {
    clauses.push(`format IN ('ebook', 'audiobook')`);
  } else if (isFormat(formatParam)) {
    clauses.push('format = ?');
    binds.push(formatParam);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await c.env.DB.prepare(`SELECT * FROM media_items ${where} ORDER BY title COLLATE NOCASE ASC`)
    .bind(...binds)
    .all<MediaItemRow>();
  return c.json((results ?? []).map(itemJson));
});

mediaCatalogRouter.get('/items/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(c.req.param('id')).first<MediaItemRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(itemJson(row));
});

mediaCatalogRouter.post('/items', async (c) => {
  const body = await c.req.json<{ title?: string; author?: string | null; format?: string; notes?: string | null }>();
  if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400);
  if (!isFormat(body.format)) return c.json({ error: `format must be one of ${FORMATS.join(', ')}` }, 400);

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO media_items (id, title, author, format, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.title.trim(), body.author?.trim() || null, body.format, body.notes?.trim() || null, ts, ts)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first<MediaItemRow>();
  return c.json(itemJson(row!), 201);
});

const BULK_CHUNK_SIZE = 100; // stays well under D1's per-batch statement cap

// POST /items/bulk — { format, rows: [{ title, author? }] }, one format
// applied to the whole batch. The "dump in hundreds of books at once"
// path (see MediaCatalogPanel's bulk-import modal) — entering them one
// at a time isn't realistic for an existing shelf, so this is the actual
// getting-started mechanism, with individual add/edit staying for
// one-offs after the fact.
mediaCatalogRouter.post('/items/bulk', async (c) => {
  const body = await c.req.json<{ format?: string; rows?: { title?: string; author?: string | null }[] }>();
  if (!isFormat(body.format)) return c.json({ error: `format must be one of ${FORMATS.join(', ')}` }, 400);
  const rows = (body.rows ?? []).map((r) => ({ title: r.title?.trim() ?? '', author: r.author?.trim() || null })).filter((r) => r.title);
  if (rows.length === 0) return c.json({ error: 'rows is required' }, 400);

  const ts = new Date().toISOString();
  const toInsert = rows.map((r) => ({ id: crypto.randomUUID(), ...r }));
  for (let i = 0; i < toInsert.length; i += BULK_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + BULK_CHUNK_SIZE);
    await c.env.DB.batch(
      chunk.map((r) =>
        c.env.DB.prepare(`INSERT INTO media_items (id, title, author, format, notes, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`).bind(
          r.id,
          r.title,
          r.author,
          body.format,
          ts,
          ts
        )
      )
    );
  }
  return c.json({ created: toInsert.length }, 201);
});

mediaCatalogRouter.patch('/items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first<MediaItemRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<{ title?: string; author?: string | null; format?: string; notes?: string | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.title !== undefined) {
    if (!body.title.trim()) return c.json({ error: 'title cannot be blank' }, 400);
    sets.push('title = ?');
    binds.push(body.title.trim());
  }
  if (body.author !== undefined) {
    sets.push('author = ?');
    binds.push(body.author?.trim() || null);
  }
  if (body.format !== undefined) {
    if (!isFormat(body.format)) return c.json({ error: `format must be one of ${FORMATS.join(', ')}` }, 400);
    sets.push('format = ?');
    binds.push(body.format);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(body.notes?.trim() || null);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(new Date().toISOString());
    binds.push(id);
    await c.env.DB.prepare(`UPDATE media_items SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first<MediaItemRow>();
  return c.json(itemJson(row!));
});

mediaCatalogRouter.delete('/items/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM media_items WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
