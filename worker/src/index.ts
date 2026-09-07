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
         SUM(CASE WHEN type IN ('file', 'link') THEN 1 ELSE 0 END) as media_count,
         SUM(CASE WHEN type = 'task' AND status != 'done' THEN 1 ELSE 0 END) as open_task_count
       FROM entities WHERE parent_id = ?`
    )
    .bind(id)
    .first<{
      pinned_count: number;
      folder_count: number;
      note_count: number;
      media_count: number;
      open_task_count: number;
    }>();
}

// Subtasks live one level deeper than the project (task -> subtask), so they
// aren't covered by sectionCounts' direct-children query above — count open
// subtasks across every task belonging to this project in one extra query.
function openSubtaskCount(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT COUNT(*) as n FROM entities
       WHERE type = 'task' AND status != 'done'
         AND parent_id IN (SELECT id FROM entities WHERE parent_id = ? AND type = 'task')`
    )
    .bind(id)
    .first<{ n: number }>();
}

// Bumps last_touched on the top-level project that owns `entityId` (which may
// itself be the project). Used so a project's "Last Modified" badge reflects
// activity anywhere inside it — a note edited three folders deep, a task
// completed, a file uploaded — not just edits to the project's own title.
// Distinct from updated_at (set on every PATCH, including pure reorders/pins)
// so promote/demote and pin toggles don't make an untouched project look busy.
async function touchProjectAncestor(db: D1Database, entityId: string | null) {
  if (!entityId) return;
  let cursor = await db
    .prepare('SELECT id, parent_id, is_top_level FROM entities WHERE id = ?')
    .bind(entityId)
    .first<{ id: string; parent_id: string | null; is_top_level: number }>();
  let guard = 0;
  while (cursor && !cursor.is_top_level && cursor.parent_id && guard++ < 20) {
    cursor = await db
      .prepare('SELECT id, parent_id, is_top_level FROM entities WHERE id = ?')
      .bind(cursor.parent_id)
      .first();
  }
  if (cursor?.is_top_level) {
    await db.prepare('UPDATE entities SET last_touched = ? WHERE id = ?').bind(now(), cursor.id).run();
  }
}

// Resolves a task's top-level project ancestor (if any), for the small
// project tag shown next to a task wherever it's displayed away from its
// own project (Today, Week). Cached per parent_id for the lifetime of one
// request, since several tasks in the same project all resolve to the same
// root and this dataset is small enough that a plain Map is plenty.
function makeProjectResolver(db: D1Database) {
  const cache = new Map<string, { id: string; title: string } | null>();
  return async function resolveProject(parentId: string | null): Promise<{ id: string; title: string } | null> {
    if (!parentId) return null;
    if (cache.has(parentId)) return cache.get(parentId)!;
    let cursor = await db
      .prepare('SELECT id, parent_id, is_top_level, type, title FROM entities WHERE id = ?')
      .bind(parentId)
      .first<{ id: string; parent_id: string | null; is_top_level: number; type: string; title: string }>();
    let guard = 0;
    while (cursor && !cursor.is_top_level && cursor.parent_id && guard++ < 20) {
      cursor = await db
        .prepare('SELECT id, parent_id, is_top_level, type, title FROM entities WHERE id = ?')
        .bind(cursor.parent_id)
        .first();
    }
    const resolved = cursor && cursor.is_top_level === 1 && cursor.type === 'project' ? { id: cursor.id, title: cursor.title } : null;
    cache.set(parentId, resolved);
    return resolved;
  };
}

// Flattens a Tiptap JSON document to plain text — a mirror kept alongside the
// rich `content` so a future search feature has clean, pre-extracted text to
// index without a historical backfill. Not queried by anything yet.
function extractPlainText(contentJson: string | null | undefined): string | null {
  if (!contentJson) return null;
  try {
    const doc = JSON.parse(contentJson);
    const parts: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const n = node as { text?: unknown; content?: unknown[] };
      if (typeof n.text === 'string') parts.push(n.text);
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(doc);
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

// Walks a Tiptap JSON document collecting its 'attachment' and 'linkPreview'
// block nodes — used when converting a Jot into a Task, since tasks (unlike
// notes/jots) have no rich body to hold them inline. Each becomes a sibling
// file/link entity under the task's destination parent instead.
function extractAttachmentsAndLinks(contentJson: string | null | undefined): {
  attachments: { url: string; filename: string; mimeType: string; r2Key: string; size: number }[];
  links: { url: string; title: string | null; image: string | null; domain: string | null }[];
} {
  const attachments: { url: string; filename: string; mimeType: string; r2Key: string; size: number }[] = [];
  const links: { url: string; title: string | null; image: string | null; domain: string | null }[] = [];
  if (!contentJson) return { attachments, links };
  try {
    const doc = JSON.parse(contentJson);
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
      if (n.type === 'attachment' && n.attrs) {
        attachments.push({
          url: String(n.attrs.url ?? ''),
          filename: String(n.attrs.filename ?? 'file'),
          mimeType: String(n.attrs.mimeType ?? 'application/octet-stream'),
          r2Key: String(n.attrs.r2Key ?? ''),
          size: Number(n.attrs.size ?? 0),
        });
      } else if (n.type === 'linkPreview' && n.attrs) {
        links.push({
          url: String(n.attrs.url ?? ''),
          title: (n.attrs.title as string | null) ?? null,
          image: (n.attrs.image as string | null) ?? null,
          domain: (n.attrs.domain as string | null) ?? null,
        });
      }
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(doc);
  } catch {
    // malformed content — nothing to extract
  }
  return { attachments, links };
}

// ---- Jots (standalone, top-level "quick capture") ----

// GET /api/jots — pinned first, then oldest-first within each group (the
// whole point of the unpinned ordering is that a jot that's been sitting the
// longest surfaces first, unlike Notes' newest-first ordering).
app.get('/api/jots', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 AND type = 'note' AND is_jot = 1
     ORDER BY pinned DESC, COALESCE(last_touched, updated_at) ASC`
  ).all<Entity>();
  return c.json(results ?? []);
});

// POST /api/jots — create a new jot. Stored as an ordinary type='note' row
// with is_jot=1 (not a distinct 'jot' type) — see the comment in
// migrations/0005_jots.sql for why. Title is optional and empty by default
// — like Keep, most jots never get one.
app.post('/api/jots', async (c) => {
  const body = await c.req
    .json<{ content?: string | null; title?: string }>()
    .catch(() => ({ content: null, title: undefined }));
  const id = uid();
  const ts = now();
  const searchText = extractPlainText(body.content ?? null);
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, is_jot)
     VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?, 1)`
  )
    .bind(id, body.title ?? '', body.content ?? null, ts, ts, ts, searchText)
    .run();
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// POST /api/entities/:id/convert — { to: 'note' | 'task', parent_id: string | null }
// Turns a Jot into a real Note or Task — the two ways a jot leaves the
// temporary-holding-spot list (the third is plain delete).
//
// 'note': a pure type + parent change. Jots and Notes share the exact same
// Tiptap `content` shape (including inline attachment/linkPreview nodes), so
// nothing about the content needs to change — parent_id may be null
// (standalone, top-level, like any other Note) or a project id.
//
// 'task': tasks have no rich body (their `content` column holds TaskMeta
// JSON, not Tiptap), so the jot's plain text becomes the task's title, and
// any attachment/linkPreview nodes become sibling file/link entities under
// the destination parent — the same shape Task attachments already take.
// Unlike 'note', parent_id is required here: MikeOS has no standalone/
// top-level task concept today, only tasks inside a project or folder.
app.post('/api/entities/:id/convert', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ to: 'note' | 'task'; parent_id: string | null; due_date?: string | null }>();

  const existing = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.parent_id) {
    const parent = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(body.parent_id).first<Entity>();
    if (!parent) return c.json({ error: 'parent not found' }, 404);
  }

  const ts = now();

  if (body.to === 'note') {
    const isTopLevel = body.parent_id === null ? 1 : 0;
    const maxPos = await c.env.DB.prepare(
      body.parent_id === null
        ? `SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'note' AND is_jot = 0`
        : 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
    )
      .bind(...(body.parent_id === null ? [] : [body.parent_id]))
      .first<{ m: number }>();

    await c.env.DB.prepare(
      `UPDATE entities SET type = 'note', is_jot = 0, title = ?, parent_id = ?, is_top_level = ?, position = ?, status = NULL, updated_at = ?, last_touched = ? WHERE id = ?`
    )
      .bind(existing.title || 'Untitled Note', body.parent_id, isTopLevel, (maxPos?.m ?? -1) + 1, ts, ts, id)
      .run();
  } else {
    // A null parent_id makes a standalone task — no project, addressable at
    // the root the same way a Jot is (is_top_level = 1). This is what
    // "plan this jot for a date" uses: it doesn't require picking a project
    // first, same as turning a jot into a standalone Note never has.
    const isTopLevel = body.parent_id === null ? 1 : 0;
    const title = extractPlainText(existing.content) || '';
    const { attachments, links } = extractAttachmentsAndLinks(existing.content);

    const maxPos = await c.env.DB.prepare(
      body.parent_id === null
        ? `SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`
        : 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
    )
      .bind(...(body.parent_id === null ? [] : [body.parent_id]))
      .first<{ m: number }>();
    const nextPos = (maxPos?.m ?? -1) + 1;

    await c.env.DB.prepare(
      `UPDATE entities SET type = 'task', is_jot = 0, title = ?, content = NULL, search_text = NULL, parent_id = ?, is_top_level = ?, position = ?, status = 'open', due_date = ?, updated_at = ?, last_touched = ? WHERE id = ?`
    )
      .bind(title, body.parent_id, isTopLevel, nextPos, body.due_date ?? null, ts, ts, id)
      .run();

    // Attachments/links extracted from the jot's content belong to the
    // *task itself* (parent_id = id, the task's own id) so they show up in
    // its own attachment list — not siblings of the task under its project.
    let attachPos = 0;
    for (const a of attachments) {
      if (!a.r2Key) continue;
      const meta = { r2_key: a.r2Key, mime_type: a.mimeType, size: a.size, filename: a.filename };
      await c.env.DB.prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
         VALUES (?, 'file', ?, ?, ?, 0, NULL, ?, ?, ?, ?)`
      )
        .bind(uid(), a.filename, JSON.stringify(meta), id, attachPos++, ts, ts, ts)
        .run();
    }
    for (const l of links) {
      if (!l.url) continue;
      const meta = { url: l.url, preview_title: l.title, preview_image: l.image, preview_domain: l.domain };
      await c.env.DB.prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
         VALUES (?, 'link', ?, ?, ?, 0, NULL, ?, ?, ?, ?)`
      )
        .bind(uid(), l.title || l.url, JSON.stringify(meta), id, attachPos++, ts, ts, ts)
        .run();
    }
  }

  await touchProjectAncestor(c.env.DB, body.parent_id);
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

// ---- Projects (top-level) ----

// GET /api/projects — list all top-level projects with a section breakdown
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 AND type = 'project' ORDER BY pinned DESC, position ASC, created_at ASC`
  ).all<Entity>();

  const withCounts = await Promise.all(
    (results ?? []).map(async (p) => {
      const [cnt, sections, subtasks] = await Promise.all([
        childCount(c.env.DB, p.id),
        sectionCounts(c.env.DB, p.id),
        openSubtaskCount(c.env.DB, p.id),
      ]);
      return {
        ...p,
        child_count: cnt?.n ?? 0,
        pinned_count: sections?.pinned_count ?? 0,
        folder_count: sections?.folder_count ?? 0,
        note_count: sections?.note_count ?? 0,
        media_count: sections?.media_count ?? 0,
        open_task_count: sections?.open_task_count ?? 0,
        open_subtask_count: subtasks?.n ?? 0,
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

// ---- Notes (standalone, top-level) ----

// GET /api/notes — top-level notes not attached to any project, pinned first
// then by last-modified (most recent first) — distinct from Projects, which
// default-sorts by manual position so drag-reordering keeps working there.
app.get('/api/notes', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 AND type = 'note' AND is_jot = 0
     ORDER BY pinned DESC, COALESCE(last_touched, updated_at) DESC`
  ).all<Entity>();
  return c.json(results ?? []);
});

// POST /api/notes — create a new standalone note (type='note', parent_id=NULL)
app.post('/api/notes', async (c) => {
  const body = await c.req.json<{ title?: string; content?: string | null }>();
  const id = uid();
  const ts = now();
  const title = body.title?.trim() || 'Untitled Note';
  const searchText = extractPlainText(body.content ?? null);
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
     VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?)`
  )
    .bind(id, title, body.content ?? null, ts, ts, ts, searchText)
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

  // Tasks can have their own child tasks (subtasks) and attachments
  // (files/links) — the same generic parent/child relationship folders
  // use. Attach one level of each here so the project's own Tasks section
  // can render subtasks nested under their parent, and a small
  // attachment/link indicator, without a separate round trip per task.
  async function fetchMedia(taskId: string) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM entities WHERE parent_id = ? AND type IN ('file', 'link') ORDER BY pinned DESC, position ASC, created_at ASC`
    )
      .bind(taskId)
      .all<Entity>();
    return results ?? [];
  }

  const withSubtasks = await Promise.all(
    (children ?? []).map(async (child) => {
      if (child.type !== 'task') return child;
      const [{ results: rawSubtasks }, media] = await Promise.all([
        c.env.DB.prepare(
          `SELECT * FROM entities WHERE parent_id = ? AND type = 'task' ORDER BY pinned DESC, position ASC, created_at ASC`
        )
          .bind(child.id)
          .all<Entity>(),
        fetchMedia(child.id),
      ]);
      // One more shallow pass so a subtask shown inline also gets its own
      // attachment indicator, without going any deeper than that.
      const subtasks = await Promise.all(
        (rawSubtasks ?? []).map(async (sub) => ({ ...sub, media: await fetchMedia(sub.id) }))
      );
      return { ...child, subtasks, media };
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

  const searchText = extractPlainText(body.content ?? null);
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.type, title, body.content ?? null, body.parent_id, status, (maxPos?.m ?? -1) + 1, ts, ts, ts, searchText)
    .run();
  await touchProjectAncestor(c.env.DB, body.parent_id);

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// PATCH /api/entities/:id — update title/content/status/parent_id
app.patch('/api/entities/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned' | 'due_date' | 'last_touched'>>
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
    fields.push('search_text = ?');
    values.push(extractPlainText(body.content));
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
  if (body.due_date !== undefined) {
    fields.push('due_date = ?');
    values.push(body.due_date);
    touchesContent = true;
  }
  // Explicit last_touched override — used only to restore a project's own
  // "last modified" stamp after an Undo (e.g. moving a note in, then right
  // back out, shouldn't leave the project looking touched). Takes priority
  // over the auto-touch below, and never triggers touchProjectAncestor
  // itself since it doesn't set touchesContent.
  let explicitTouch = false;
  if (body.last_touched !== undefined) {
    fields.push('last_touched = ?');
    values.push(body.last_touched);
    explicitTouch = true;
  }

  // A pure last_touched restore (nothing else in the patch) is invisible
  // bookkeeping, not a real edit — skip bumping updated_at for it too, or a
  // project with no last_touched of its own yet (falls back to updated_at
  // for display) would still appear freshly modified after the "restore".
  const isPureTouchRestore = explicitTouch && fields.length === 1;
  const ts = now();
  if (!isPureTouchRestore) {
    fields.push('updated_at = ?');
    values.push(ts);
  }
  if (touchesContent && !explicitTouch) {
    fields.push('last_touched = ?');
    values.push(ts);
  }

  values.push(id);
  await c.env.DB.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  if (touchesContent) await touchProjectAncestor(c.env.DB, id);

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

// DELETE /api/entities/:id — recursively deletes descendants too (explicit
// walk rather than relying on FK cascade, since SQLite/D1 only enforces
// ON DELETE CASCADE when foreign_keys is pragma'd on for the connection)
app.delete('/api/entities/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT parent_id FROM entities WHERE id = ?').bind(id).first<{ parent_id: string | null }>();

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
  await touchProjectAncestor(c.env.DB, existing?.parent_id ?? null);
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

// POST /api/entities/:id/move — { parent_id: string | null }
// Atomically reparents an entity: updates parent_id, recomputes is_top_level,
// and appends position at the end of the destination's children. Used for
// "Move to Project" (parent_id: a project/folder id) and its reverse,
// "Move to Notes" (parent_id: null). Kept as its own endpoint — rather than
// folded into the generic PATCH — so the three fields always move together
// and both the old and new parent's "last modified" ancestors get touched.
app.post('/api/entities/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ parent_id: string | null }>();

  const existing = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.parent_id) {
    const parent = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(body.parent_id).first<Entity>();
    if (!parent) return c.json({ error: 'parent not found' }, 404);
  }

  const isTopLevel = body.parent_id === null ? 1 : 0;
  const maxPos = await c.env.DB.prepare(
    body.parent_id === null
      ? 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = ?'
      : 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
  )
    .bind(body.parent_id === null ? existing.type : body.parent_id)
    .first<{ m: number }>();

  const ts = now();
  await c.env.DB.prepare(
    'UPDATE entities SET parent_id = ?, is_top_level = ?, position = ?, updated_at = ? WHERE id = ?'
  )
    .bind(body.parent_id, isTopLevel, (maxPos?.m ?? -1) + 1, ts, id)
    .run();

  // Touch both the origin project tree and the new location (walking up from
  // the moved entity itself covers the destination — including the case
  // where it's now standalone and IS the top-level ancestor).
  await touchProjectAncestor(c.env.DB, existing.parent_id);
  await touchProjectAncestor(c.env.DB, id);

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
    await touchProjectAncestor(c.env.DB, parentId);
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

// ---- Link previews ----

// GET /api/link-preview?url=... — fetches the target page server-side (a
// browser fetch would hit CORS on almost every real site) and pulls its
// og:title/og:image (falling back to twitter:image, then <title>) via
// HTMLRewriter, Workers' built-in streaming HTML parser — no dependency
// needed for the couple of tags this cares about. Always resolves with at
// least a domain so the editor can fall back to a bare-link-style card
// rather than failing outright when a site can't be unfurled (blocks
// non-browser UAs, times out, 404s, etc).
app.get('/api/link-preview', async (c) => {
  const raw = c.req.query('url');
  if (!raw) return c.json({ error: 'url is required' }, 400);

  const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let domain: string | null = null;
  try {
    domain = new URL(target).hostname.replace(/^www\./, '');
  } catch {
    return c.json({ error: 'invalid url' }, 400);
  }

  const result: { url: string; title: string | null; image: string | null; domain: string | null } = {
    url: target,
    title: null,
    image: null,
    domain,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(target, {
      signal: controller.signal,
      headers: {
        // Plenty of sites serve a bare/blank <head> to non-browser user
        // agents — a normal desktop UA gets the real og: tags instead.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);

    let twitterImage: string | null = null;
    let titleTag = '';
    const rewriter = new HTMLRewriter()
      .on('meta[property="og:title"]', {
        element(el) {
          const v = el.getAttribute('content');
          if (v && !result.title) result.title = v;
        },
      })
      .on('meta[property="og:image"]', {
        element(el) {
          const v = el.getAttribute('content');
          if (v && !result.image) result.image = v;
        },
      })
      .on('meta[name="twitter:image"]', {
        element(el) {
          const v = el.getAttribute('content');
          if (v && !twitterImage) twitterImage = v;
        },
      })
      .on('title', {
        text(t) {
          titleTag += t.text;
        },
      });

    // Nothing downstream needs the rewritten HTML itself — just consume the
    // transformed body so the handlers above actually fire.
    await rewriter.transform(res).text();

    if (!result.title && titleTag.trim()) result.title = titleTag.trim();
    if (!result.image && twitterImage) result.image = twitterImage;
    if (result.image) {
      try {
        result.image = new URL(result.image, target).toString();
      } catch {
        // leave as-is if it's already absolute-ish or malformed
      }
    }
  } catch {
    // Fetch failed/timed out — the caller still gets a domain-only result,
    // which the editor renders as a plain link card instead of failing.
  }

  return c.json(result);
});

// ---- Today (daily planner) ----

// POST /api/tasks — create a standalone task with no project (parent_id
// NULL, is_top_level = 1, same "addressable at the root" pattern Jots use).
// This is the quick-add path on the Today page itself ("wash the car
// Thursday" with no natural project home) — planning a Jot for a date goes
// through /api/entities/:id/convert instead, since that's an existing item
// being turned into a task rather than a brand new one.
app.post('/api/tasks', async (c) => {
  const body = await c.req.json<{ title: string; due_date?: string | null }>();
  const title = body.title?.trim();
  if (!title) return c.json({ error: 'title is required' }, 400);

  const maxPos = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`
  ).first<{ m: number }>();

  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at)
     VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?)`
  )
    .bind(id, title, (maxPos?.m ?? -1) + 1, body.due_date ?? null, ts, ts, ts)
    .run();

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// GET /api/today?date=YYYY-MM-DD — every open task due on or before `date`,
// across every project plus standalone tasks, split into Overdue (due
// before the given date) and Today (due exactly on it) — the core query the
// daily planner view is built on. A past date works the same way (asking
// "what was outstanding as of that day"), which is what makes history just
// a different `date` rather than a separately-maintained thing.
app.get('/api/today', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date ASC, position ASC`
  )
    .bind(date)
    .all<Entity>();

  const resolveProject = makeProjectResolver(c.env.DB);
  const withProject = await Promise.all(
    (results ?? []).map(async (task) => ({ ...task, project: await resolveProject(task.parent_id) }))
  );

  const overdue = withProject.filter((t) => t.due_date! < date);
  const today = withProject.filter((t) => t.due_date === date);

  return c.json({ date, overdue, today });
});

// GET /api/week?start=YYYY-MM-DD&today=YYYY-MM-DD — a 7-day docket starting
// on `start` (a Monday, matching a physical weekly planner), one bucket per
// day of exactly what's due that day, plus an `unscheduled` shelf of every
// open task with no due date at all (draggable onto a day by the client).
// Overdue and the stale-item Tickler are deliberately NOT repeated on every
// column — "overdue" only means anything relative to the real current day,
// so both are attached only to whichever day matches `today` (when that day
// falls inside the visible week at all; looking at a past or future week
// shows neither, same as a paper planner's other weeks never show today's
// leftovers). `unscheduled`, by contrast, isn't day-relative, so it's always
// returned regardless of which week is being viewed.
app.get('/api/week', async (c) => {
  const start = c.req.query('start');
  const today = c.req.query('today');
  if (!start) return c.json({ error: 'start query param is required (YYYY-MM-DD, a Monday)' }, 400);

  const days: string[] = [];
  {
    const [y, m, d] = start.split('-').map(Number);
    const cursor = new Date(y, m - 1, d);
    for (let i = 0; i < 7; i++) {
      const dt = new Date(cursor);
      dt.setDate(cursor.getDate() + i);
      days.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
    }
  }
  const end = days[6];

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date ASC, position ASC`
  )
    .bind(end)
    .all<Entity>();

  const resolveProject = makeProjectResolver(c.env.DB);
  const withProject = await Promise.all(
    (results ?? []).map(async (task) => ({ ...task, project: await resolveProject(task.parent_id) }))
  );

  const todayInRange = today && days.includes(today) ? today : null;
  const overdue = todayInRange ? withProject.filter((t) => t.due_date! < todayInRange) : [];

  // Every open task with no due date at all, oldest-touched first — the
  // "Unscheduled" shelf below the week grid. This used to be represented by
  // a single stale-undated-task Tickler entry, but now that the whole shelf
  // is visible and draggable onto a day, that one-item nudge was just a
  // duplicate of its own top row — dropped in favor of showing the real
  // list. Capped well above what anyone would actually let pile up, purely
  // as a sanity ceiling rather than a real pagination boundary.
  const { results: unscheduledRaw } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NULL ORDER BY COALESCE(last_touched, updated_at) ASC LIMIT 50`
  ).all<Entity>();
  const unscheduled = await Promise.all(
    (unscheduledRaw ?? []).map(async (task) => ({ ...task, project: await resolveProject(task.parent_id) }))
  );

  let tickler: (Entity & { staleness: string })[] = [];
  if (todayInRange) {
    const [staleJot, staleNote] = await Promise.all([
      c.env.DB.prepare(
        `SELECT * FROM entities WHERE type = 'note' AND is_jot = 1 ORDER BY COALESCE(last_touched, updated_at) ASC LIMIT 1`
      ).first<Entity>(),
      c.env.DB.prepare(
        `SELECT * FROM entities WHERE type = 'note' AND is_jot = 0 AND parent_id IS NULL ORDER BY COALESCE(last_touched, updated_at) ASC LIMIT 1`
      ).first<Entity>(),
    ]);
    tickler = [
      staleJot ? { ...staleJot, staleness: 'jot' } : null,
      staleNote ? { ...staleNote, staleness: 'note' } : null,
    ].filter((x): x is Entity & { staleness: string } => x !== null);
  }

  const byDay = days.map((date) => ({
    date,
    isToday: date === todayInRange,
    tasks: withProject.filter((t) => t.due_date === date),
  }));

  return c.json({ start, end, days: byDay, overdue, tickler, unscheduled });
});

app.get('/api/health', (c) => c.json({ ok: true, time: now() }));

export default app;
