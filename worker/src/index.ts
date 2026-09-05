import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Entity } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const corsMiddleware = cors({ origin: c.env.ALLOWED_ORIGIN ?? '*' });
  return corsMiddleware(c, next);
});

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function childCount(db: D1Database, id: string) {
  return db.prepare('SELECT COUNT(*) as n FROM entities WHERE parent_id = ?').bind(id).first<{ n: number }>();
}

// Per-project breakdown shown on the projects list — direct children only
// (matching what the project's own Pinned section shows), open tasks only
// so a project with a long done-list doesn't look busier than it is.
function sectionCounts(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_count,
         SUM(CASE WHEN type = 'folder' THEN 1 ELSE 0 END) as folder_count,
         SUM(CASE WHEN type = 'note' THEN 1 ELSE 0 END) as note_count,
         SUM(CASE WHEN type = 'task' AND status != 'done' THEN 1 ELSE 0 END) as open_task_count
       FROM entities WHERE parent_id = ?`
    )
    .bind(id)
    .first<{ pinned_count: number; folder_count: number; note_count: number; open_task_count: number }>();
}

// ---- Projects (top-level) ----

// GET /api/projects — list all top-level projects with a section breakdown
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 ORDER BY pinned DESC, position ASC, created_at ASC`
  ).all<Entity>();

  const withCounts = await Promise.all(
    (results ?? []).map(async (p) => {
      const [cnt, sections] = await Promise.all([childCount(c.env.DB, p.id), sectionCounts(c.env.DB, p.id)]);
      return {
        ...p,
        child_count: cnt?.n ?? 0,
        pinned_count: sections?.pinned_count ?? 0,
        folder_count: sections?.folder_count ?? 0,
        note_count: sections?.note_count ?? 0,
        open_task_count: sections?.open_task_count ?? 0,
      };
    })
  );
  return c.json(withCounts);
});

// POST /api/projects — create a new top-level project { title, description }
app.post('/api/projects', async (c) => {
  const body = await c.req.json<{ title: string; description?: string }>();
  if (!body.title || !body.title.trim()) {
    return c.json({ error: 'title is required' }, 400);
  }
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
     VALUES (?, 'project', ?, ?, NULL, 1, 'active', 0, ?, ?, ?)`
  )
    .bind(id, body.title.trim(), body.description ?? '', ts, ts, ts)
    .run();
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// ---- Generic entities ----

// GET /api/entities/:id — a single entity plus its breadcrumb + children
app.get('/api/entities/:id', async (c) => {
  const id = c.req.param('id');
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  if (!entity) return c.json({ error: 'not found' }, 404);

  // breadcrumb: walk up parent_id chain
  const breadcrumb: Entity[] = [];
  let cursor: Entity | null = entity;
  while (cursor?.parent_id) {
    const parent: Entity | null = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(cursor.parent_id).first<Entity>();
    if (!parent) break;
    breadcrumb.unshift(parent);
    cursor = parent;
  }

  const { results: children } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE parent_id = ? ORDER BY pinned DESC, position ASC, created_at ASC`
  )
    .bind(id)
    .all<Entity>();

  // Tasks can have their own child tasks (subtasks) — the same generic
  // parent/child relationship folders use. Attach one level of them here
  // so the project's own Tasks section can render subtasks nested under
  // their parent without a separate round trip per task.
  const withSubtasks = await Promise.all(
    (children ?? []).map(async (child) => {
      if (child.type !== 'task') return child;
      const { results: subtasks } = await c.env.DB.prepare(
        `SELECT * FROM entities WHERE parent_id = ? AND type = 'task' ORDER BY pinned DESC, position ASC, created_at ASC`
      )
        .bind(child.id)
        .all<Entity>();
      return { ...child, subtasks: subtasks ?? [] };
    })
  );

  return c.json({ entity, breadcrumb, children: withSubtasks });
});

// POST /api/entities — create a folder/note/task/link as a child of parent_id
// (files go through POST /api/upload instead, since they carry binary data)
app.post('/api/entities', async (c) => {
  const body = await c.req.json<{
    type: 'folder' | 'note' | 'task' | 'link';
    title?: string;
    content?: string | null;
    parent_id: string;
    status?: string | null;
  }>();

  if (!body.parent_id) return c.json({ error: 'parent_id is required' }, 400);
  if (!['folder', 'note', 'task', 'link'].includes(body.type)) {
    return c.json({ error: 'invalid type' }, 400);
  }

  const parent = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(body.parent_id).first<Entity>();
  if (!parent) return c.json({ error: 'parent not found' }, 404);

  const maxPos = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
  )
    .bind(body.parent_id)
    .first<{ m: number }>();

  const id = uid();
  const ts = now();
  const title =
    body.title?.trim() ||
    (body.type === 'note' ? 'Untitled Note' : body.type === 'task' ? '' : body.type === 'link' ? 'New Link' : 'New Folder');
  const status = body.type === 'task' ? (body.status ?? 'open') : null;

  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.type, title, body.content ?? null, body.parent_id, status, (maxPos?.m ?? -1) + 1, ts, ts, ts)
    .run();

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// PATCH /api/entities/:id — update title/content/status/parent_id
app.patch('/api/entities/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned'>>
  >();

  const existing = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  let touchesContent = false;

  if (body.title !== undefined) {
    fields.push('title = ?');
    values.push(body.title);
    touchesContent = true;
  }
  if (body.content !== undefined) {
    fields.push('content = ?');
    values.push(body.content);
    touchesContent = true;
  }
  if (body.status !== undefined) {
    fields.push('status = ?');
    values.push(body.status);
    touchesContent = true;
  }
  if (body.parent_id !== undefined) {
    fields.push('parent_id = ?');
    values.push(body.parent_id);
  }
  if (body.position !== undefined) {
    fields.push('position = ?');
    values.push(body.position);
  }
  if (body.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(body.pinned);
  }

  const ts = now();
  fields.push('updated_at = ?');
  values.push(ts);
  if (touchesContent) {
    fields.push('last_touched = ?');
    values.push(ts);
  }

  values.push(id);
  await c.env.DB.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

// DELETE /api/entities/:id — recursively deletes descendants too (explicit
// walk rather than relying on FK cascade, since SQLite/D1 only enforces
// ON DELETE CASCADE when foreign_keys is pragma'd on for the connection)
app.delete('/api/entities/:id', async (c) => {
  const id = c.req.param('id');

  // Purge any R2 objects belonging to file entities in this subtree before
  // the rows disappear, so attachments don't leak storage.
  const { results: files } = await c.env.DB.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM entities WHERE id = ?
       UNION ALL
       SELECT e.id FROM entities e JOIN descendants d ON e.parent_id = d.id
     )
     SELECT content FROM entities WHERE id IN (SELECT id FROM descendants) AND type = 'file'`
  )
    .bind(id)
    .all<{ content: string | null }>();
  for (const row of files ?? []) {
    if (!row.content) continue;
    try {
      const meta = JSON.parse(row.content) as { r2_key?: string };
      if (meta.r2_key) await c.env.FILES.delete(meta.r2_key);
    } catch {
      // malformed metadata — nothing to clean up
    }
  }

  await c.env.DB.prepare(
    `DELETE FROM entities WHERE id IN (
       WITH RECURSIVE descendants(id) AS (
         SELECT id FROM entities WHERE id = ?
         UNION ALL
         SELECT e.id FROM entities e JOIN descendants d ON e.parent_id = d.id
       )
       SELECT id FROM descendants
     )`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// POST /api/entities/reorder — { parent_id: string | null, ordered_ids: string[] }
// parent_id is null when reordering top-level projects.
app.post('/api/entities/reorder', async (c) => {
  const body = await c.req.json<{ parent_id: string | null; ordered_ids: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);

  const parentClause = body.parent_id === null ? 'parent_id IS NULL' : 'parent_id = ?';
  const stmts = body.ordered_ids.map((entityId, index) => {
    const stmt = c.env.DB.prepare(
      `UPDATE entities SET position = ? WHERE id = ? AND ${parentClause}`
    );
    return body.parent_id === null ? stmt.bind(index, entityId) : stmt.bind(index, entityId, body.parent_id);
  });
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// POST /api/entities/:id/pin — { pinned: boolean }
app.post('/api/entities/:id/pin', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ pinned: boolean }>();
  await c.env.DB.prepare('UPDATE entities SET pinned = ?, updated_at = ? WHERE id = ?')
    .bind(body.pinned ? 1 : 0, now(), id)
    .run();
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

// ---- File attachments (R2-backed) ----

// POST /api/upload — multipart/form-data with a "file" field.
// With a "parent_id" field, creates a `file` entity as a child of that
// folder (shown in the Files section). Without it, this is an inline
// attachment for a note: the object is stored and its URL returned, but no
// entity row is created — the Tiptap doc itself references the URL.
app.post('/api/upload', async (c) => {
  const form = await c.req.formData();
  const rawFile = form.get('file');
  if (!rawFile || typeof rawFile === 'string') return c.json({ error: 'file is required' }, 400);
  const file = rawFile as File;

  const parentId = form.get('parent_id')?.toString() || null;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  const key = `${uid()}-${safeName}`;
  const buf = await file.arrayBuffer();
  const mimeType = file.type || 'application/octet-stream';

  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: mimeType } });

  const meta = { r2_key: key, mime_type: mimeType, size: buf.byteLength, filename: file.name };

  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(parentId).first<Entity>();
    if (!parent) return c.json({ error: 'parent not found' }, 404);
    const maxPos = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
    )
      .bind(parentId)
      .first<{ m: number }>();
    const id = uid();
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
       VALUES (?, 'file', ?, ?, ?, 0, NULL, ?, ?, ?, ?)`
    )
      .bind(id, file.name, JSON.stringify(meta), parentId, (maxPos?.m ?? -1) + 1, ts, ts, ts)
      .run();
    const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
    return c.json(entity, 201);
  }

  return c.json({ ...meta, url: `/api/files/${key}` }, 201);
});

// GET /api/files/:key — stream an object back out. ?download=1 forces a
// "Save As" download instead of inline viewing.
app.get('/api/files/:key', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.text('not found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (c.req.query('download') === '1') {
    headers.set('content-disposition', 'attachment');
  }
  return new Response(obj.body, { headers });
});

// DELETE /api/files/:key — purge a single R2 object (used when removing an
// inline attachment from a note; standalone `file` entities are cleaned up
// automatically by DELETE /api/entities/:id instead).
app.delete('/api/files/:key', async (c) => {
  await c.env.FILES.delete(c.req.param('key'));
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ ok: true, time: now() }));

export default app;
