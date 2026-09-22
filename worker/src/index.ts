import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type {
  CanvasBoard,
  CanvasConnector,
  CanvasItem,
  CanvasItemType,
  Bet,
  Contact,
  ContactCircle,
  ContactConnection,
  ContactNote,
  Env,
  Entity,
  Habit,
  HabitLog,
  HealthWeeklyReport,
  ImportBatch,
  JournalEntry,
  NewsArticleRow,
  NewsFeedRow,
  NewsSavedRow,
  ShelfItem,
  ShelfItemType,
  TaskReschedule,
  VoterRecord,
} from './types';
import { calendarIdFromIcsUrl, meetingsForDate, meetingsForRange } from './ics';
import { describeRrule, isValidRrule, nextDueOccurrenceDate, type RecurringTaskDefinition } from './recurring';
import { HealthParseError, parseHealthWeek } from './health';
import { FeedParseError, parseFeed } from './news';
import { authGate, authRouter, resolveOrigin } from './auth';
import { vaultRouter } from './vault';

const app = new Hono<{ Bindings: Env }>();

// Cookie-based sessions require CORS to echo back one specific,
// allowlisted origin with credentials enabled — a wildcard "*" origin
// can't carry credentials per the CORS spec, so every request's Origin
// header is checked against ALLOWED_ORIGINS (see auth.ts's resolveOrigin)
// rather than using Hono's static-origin shorthand.
app.use('*', async (c, next) => {
  const corsMiddleware = cors({ origin: (origin) => (origin && resolveOrigin(c) === origin ? origin : undefined), credentials: true });
  return corsMiddleware(c, next);
});

// Every /api/* route requires a valid session except /api/auth/* itself
// (login/registration/status obviously can't require already being
// logged in). Mounted before any other route so nothing downstream is
// reachable without it.
app.route('/api/auth', authRouter);
app.use('/api/*', authGate);
app.route('/api/vault', vaultRouter);

// Hono's default unhandled-error response is a bare "Internal Server Error"
// with no body — fine for not leaking internals to an outside caller, but
// this app has exactly one caller (its own frontend, same person on both
// ends) and that blank response is what turned a real, diagnosable D1 error
// into an opaque "API 500" for Mike with nothing to go on. Surface the
// actual message instead so a report like that comes with something
// actionable in it; still logs server-side too, in case Cloudflare's own
// logs are checked directly.
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// 'YYYY-MM-DD' strings compare correctly with plain string comparison.
const maxIso = (a: string, b: string) => (a > b ? a : b);

// Same home-timezone treatment the frontend uses for meeting times
// (MEETING_TZ in TodayPage/WeekPage/MonthPage) — a task finished at
// 11:40 PM ET should count toward that day, not flip to "tomorrow" just
// because the worker itself runs in UTC. en-CA's date formatting comes
// out as YYYY-MM-DD directly, so no reassembly is needed.
const HOME_TZ = 'America/New_York';
function localDateString(iso: string, tz: string = HOME_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

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

// Direct-child item counts for a List's card on the Lists index page —
// deliberately simpler than sectionCounts (no folder/note/media split, since
// a List never has those kinds of children in practice).
function listItemCounts(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) as open_count,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count
       FROM entities WHERE parent_id = ? AND type = 'task'`
    )
    .bind(id)
    .first<{ open_count: number; done_count: number }>();
}

// Deletes an entity and every descendant (same recursive-CTE walk as
// DELETE /api/entities/:id, factored out so "Clear completed" on a List can
// remove a batch of items — including any of their own R2 attachments —
// without duplicating this logic).
async function deleteEntityDeep(db: D1Database, files: R2Bucket, id: string) {
  const { results: fileRows } = await db
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM entities WHERE id = ?
         UNION ALL
         SELECT e.id FROM entities e JOIN descendants d ON e.parent_id = d.id
       )
       SELECT content FROM entities WHERE id IN (SELECT id FROM descendants) AND type = 'file'`
    )
    .bind(id)
    .all<{ content: string | null }>();
  for (const row of fileRows ?? []) {
    if (!row.content) continue;
    try {
      const meta = JSON.parse(row.content) as { r2_key?: string };
      if (meta.r2_key) await files.delete(meta.r2_key);
    } catch {
      // malformed metadata — nothing to clean up
    }
  }
  await db
    .prepare(
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

// Lazily materializes recurring tasks — no cron trigger, this just runs at
// the top of every GET /api/today so a spawn happens on the next page load
// on or after it's due (same "no extra infra" spirit as everything else in
// the planner). For each active definition: if its current_task_id still
// points to an open task, it's still outstanding, so nothing spawns — a
// definition only ever has one live instance at a time. Otherwise, spawn
// the earliest occurrence that's due on or before `todayIso` (see
// nextDueOccurrenceDate — if several were missed while the last instance
// sat open, only the oldest one spawns; it lands with a due_date in the
// past and rolls straight into Overdue, same as any other dated task).
async function spawnDueRecurringTasks(db: D1Database, todayIso: string): Promise<void> {
  const { results } = await db
    .prepare(`SELECT * FROM recurring_task_definitions WHERE active = 1`)
    .all<RecurringTaskDefinition>();

  for (const def of results ?? []) {
    if (def.current_task_id) {
      const current = await db
        .prepare(`SELECT status FROM entities WHERE id = ?`)
        .bind(def.current_task_id)
        .first<{ status: string | null }>();
      if (current && current.status === 'open') continue; // still outstanding
    }

    let dueDate: string | null;
    try {
      dueDate = nextDueOccurrenceDate(def.rrule, def.dtstart, def.last_spawned_due_date, todayIso);
    } catch {
      continue; // a malformed RRULE shouldn't take the whole endpoint down
    }
    if (!dueDate) continue;

    const id = uid();
    const ts = now();
    if (def.project_id) {
      const maxPos = await db
        .prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?`)
        .bind(def.project_id)
        .first<{ m: number }>();
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at)
           VALUES (?, 'task', ?, ?, 0, 'open', ?, ?, ?, ?, ?)`
        )
        .bind(id, def.title, def.project_id, (maxPos?.m ?? -1) + 1, dueDate, ts, ts, ts)
        .run();
      await touchProjectAncestor(db, def.project_id);
    } else {
      const maxPos = await db
        .prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`)
        .first<{ m: number }>();
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at)
           VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?)`
        )
        .bind(id, def.title, (maxPos?.m ?? -1) + 1, dueDate, ts, ts, ts)
        .run();
    }

    await db
      .prepare(`UPDATE recurring_task_definitions SET current_task_id = ?, last_spawned_due_date = ?, updated_at = ? WHERE id = ?`)
      .bind(id, dueDate, ts, def.id)
      .run();
  }
}

// The set of task ids that are currently the live instance of an active
// recurring definition — used to tag `is_recurring` on task rows (see
// tagRecurring below) so the client can mark them distinctly ("Recurring"
// in place of the usual last-modified badge) and float them to the top of
// the day's list instead of mixing in wherever their due_position lands.
async function recurringCurrentTaskIds(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT current_task_id FROM recurring_task_definitions WHERE active = 1 AND current_task_id IS NOT NULL`)
    .all<{ current_task_id: string }>();
  return new Set((results ?? []).map((r) => r.current_task_id));
}

function tagRecurring<T extends Entity>(tasks: T[], recurringIds: Set<string>): T[] {
  return tasks.map((t) => ({ ...t, is_recurring: recurringIds.has(t.id) }));
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

// ---- Shelf (drop zone on the Jots page) ----

const SHELF_TYPES: ShelfItemType[] = ['text', 'image', 'link', 'file'];

// GET /api/shelf — pinned first, then newest first. Deliberately no
// auto-clear sweep: Mike wants items to sit here until he explicitly
// deletes them, not vanish on a timer he doesn't control.
app.get('/api/shelf', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM shelf_items ORDER BY pinned DESC, created_at DESC').all<ShelfItem>();
  return c.json(results ?? []);
});

// POST /api/shelf — drop one item. `content` is pre-shaped by the caller
// per type (see migrations/0016_shelf_items.sql) — the worker just
// validates `type` and stores it, the same "trust the client, shape is
// documented not enforced" pattern canvas_items.content already uses.
app.post('/api/shelf', async (c) => {
  const body = await c.req.json<{ type: ShelfItemType; content: Record<string, unknown> }>();
  if (!SHELF_TYPES.includes(body.type)) return c.json({ error: 'invalid type' }, 400);
  const id = uid();
  const ts = now();
  await c.env.DB.prepare('INSERT INTO shelf_items (id, type, content, pinned, created_at) VALUES (?, ?, ?, 0, ?)')
    .bind(id, body.type, JSON.stringify(body.content ?? {}), ts)
    .run();
  const item = await c.env.DB.prepare('SELECT * FROM shelf_items WHERE id = ?').bind(id).first<ShelfItem>();
  return c.json(item, 201);
});

// PATCH /api/shelf/:id — currently only { pinned: boolean }, i.e. "Pin to
// top" / "Unpin", matching the same pattern on Jots, Boards, and Projects.
app.patch('/api/shelf/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ pinned?: boolean }>();
  const existing = await c.env.DB.prepare('SELECT id FROM shelf_items WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (body.pinned !== undefined) {
    await c.env.DB.prepare('UPDATE shelf_items SET pinned = ? WHERE id = ?').bind(body.pinned ? 1 : 0, id).run();
  }
  const item = await c.env.DB.prepare('SELECT * FROM shelf_items WHERE id = ?').bind(id).first<ShelfItem>();
  return c.json(item);
});

app.delete('/api/shelf/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM shelf_items WHERE id = ?').bind(id).first<ShelfItem>();
  if (existing && (existing.type === 'image' || existing.type === 'file')) {
    const meta = JSON.parse(existing.content) as { r2_key?: string };
    if (meta.r2_key) await c.env.FILES.delete(meta.r2_key).catch(() => {});
  }
  await c.env.DB.prepare('DELETE FROM shelf_items WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// POST /api/shelf/:id/graduate — turns a shelf item into a real Jot (the
// one way something on the shelf becomes permanent, short of pinning it)
// and removes it from the shelf. Builds the same Tiptap `content` shape
// Jots/Notes already use (see extractAttachmentsAndLinks above for the
// attachment/linkPreview node shapes) so the resulting Jot is completely
// ordinary — nothing downstream needs to know it came from the shelf.
app.post('/api/shelf/:id/graduate', async (c) => {
  const id = c.req.param('id');
  const item = await c.env.DB.prepare('SELECT * FROM shelf_items WHERE id = ?').bind(id).first<ShelfItem>();
  if (!item) return c.json({ error: 'not found' }, 404);

  const meta = JSON.parse(item.content) as Record<string, unknown>;
  let doc: Record<string, unknown>;
  if (item.type === 'text') {
    doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: String(meta.text ?? '') }] }] };
  } else if (item.type === 'link') {
    doc = { type: 'doc', content: [{ type: 'linkPreview', attrs: { url: meta.url ?? '', title: meta.title ?? null, image: meta.image ?? null, domain: meta.domain ?? null } }] };
  } else {
    // image | file
    doc = {
      type: 'doc',
      content: [
        { type: 'attachment', attrs: { url: `/api/files/${meta.r2_key}`, filename: meta.filename ?? 'file', mimeType: meta.mime_type ?? 'application/octet-stream', r2Key: meta.r2_key ?? '', size: meta.size ?? 0 } },
      ],
    };
  }

  const jotId = uid();
  const ts = now();
  const contentJson = JSON.stringify(doc);
  const searchText = extractPlainText(contentJson);
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, is_jot)
     VALUES (?, 'note', '', ?, NULL, 1, NULL, 0, ?, ?, ?, ?, 1)`
  )
    .bind(jotId, contentJson, ts, ts, ts, searchText)
    .run();
  await c.env.DB.prepare('DELETE FROM shelf_items WHERE id = ?').bind(id).run();

  const jot = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(jotId).first<Entity>();
  return c.json(jot, 201);
});

// ---- Contacts (personal CRM) ----

// A close-spelling-forgiving name matcher — inspired by "Thanks Bud"
// (heythanksbud.com), whose search explicitly handles typos on a name you
// half-remember. Plain LIKE only catches a query that's an exact substring;
// this adds a Levenshtein-distance fallback so "Kathrine" still finds
// "Katherine". Deliberately scoped to Contacts only (here and in
// runSearch's contacts group below) — a fuzzy pass over note/task body text
// would mostly just add noise, but a half-remembered name is exactly what
// this feature is for.
function normalizeForFuzzy(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 100 = exact, 80 = starts-with, 60 = substring — same scale matchScore
// uses elsewhere — then a fuzzy tier for anything within edit-distance of
// the whole name or of one of its individual words (so "Jon Smith" still
// fuzzy-matches a query of just "Smyth"). Threshold scales with query
// length: a 1-character typo in a long name is meaningful, the same
// distance on a 3-letter query is basically a different word.
function fuzzyNameScore(name: string, q: string): number {
  const n = normalizeForFuzzy(name);
  const query = normalizeForFuzzy(q);
  if (!query || !n) return 0;
  if (n === query) return 100;
  if (n.startsWith(query)) return 80;
  if (n.includes(query)) return 60;

  const threshold = query.length <= 4 ? 1 : query.length <= 7 ? 2 : 3;
  const whole = levenshtein(n, query);
  if (whole <= threshold) return Math.max(20, 45 - whole * 8);
  for (const word of name.split(/\s+/)) {
    const w = normalizeForFuzzy(word);
    if (!w) continue;
    const dist = levenshtein(w, query);
    const wordThreshold = query.length <= 4 ? 1 : 2;
    if (dist <= wordThreshold) return Math.max(15, 40 - dist * 8);
  }
  return 0;
}

function textIncludes(text: string | null, q: string): boolean {
  return !!text && text.toLowerCase().includes(q.toLowerCase());
}

const CIRCLES: ContactCircle[] = ['family', 'friends', 'neighbors', 'community', 'professional', 'other'];

// GET /api/contacts — pinned first, then alphabetical (this is a lookup
// list you browse by name, unlike Jots/Shelf's recency ordering).
// ?q= searches both contact names and their note text, so "restaurant"
// finds Alice even though her name doesn't contain it.
// ?circle= filters to one circle.
// ?reminders=1 returns only contacts with an unresolved, due check-in note.
// ?voters=1 includes standalone voter-roll entries (source='voter_file' —
// a voter-file row that didn't match any personal contact, so it became its
// own contact with no relationship to Mike at all). These default to
// EXCLUDED: personal contacts are the CRM, the voter roll is 12k+ rows of
// people Mike has never met, and mixing them in by default is exactly what
// made it "feel like" personal contacts weren't searchable — a search for
// a common name returns far more voter-roll matches than personal ones, and
// they buried each other in an unsorted mix. A merged contact (voter data
// blended onto a contact Mike already had) keeps its original source and is
// never affected by this filter.
app.get('/api/contacts', async (c) => {
  const q = c.req.query('q')?.trim();
  const circle = c.req.query('circle');
  const remindersOnly = c.req.query('reminders') === '1';
  const includeVoters = c.req.query('voters') === '1';

  let sql = 'SELECT * FROM contacts WHERE 1=1';
  const binds: unknown[] = [];

  if (!includeVoters) {
    sql += " AND source != 'voter_file'";
  }
  if (circle && CIRCLES.includes(circle as ContactCircle)) {
    sql += ' AND circle = ?';
    binds.push(circle);
  }
  if (remindersOnly) {
    sql += " AND id IN (SELECT contact_id FROM contact_notes WHERE remind_resolved = 0 AND remind_at IS NOT NULL AND remind_at <= ?)";
    binds.push(now());
  }
  // COLLATE NOCASE — voter-roll names import as ALL CAPS while personal
  // contacts keep normal case; a plain binary ORDER BY name ASC sorts every
  // uppercase name before any lowercase one (ASCII 'A' < 'a'), which packs
  // all voter entries before personal ones regardless of actual alphabetical
  // order. Matters most when includeVoters=1, but correct either way.
  sql += ' ORDER BY pinned DESC, name COLLATE NOCASE ASC';

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Contact>();
  let contacts = results ?? [];

  // `q` is scored rather than filtered by SQL — fuzzyNameScore's typo
  // tolerance can't be expressed as a LIKE, so name/headline/company
  // matching (plus a note-text hit) all happen here in JS instead. Fine
  // at this app's contacts-table scale (same trade already made for
  // birthday/anniversary matching above).
  if (q) {
    const { results: noteHits } = await c.env.DB.prepare('SELECT DISTINCT contact_id FROM contact_notes WHERE text LIKE ?').bind(`%${q}%`).all<{ contact_id: string }>();
    const noteHitIds = new Set((noteHits ?? []).map((n) => n.contact_id));
    contacts = contacts
      .map((ct) => {
        const nameScore = fuzzyNameScore(ct.name, q);
        const fieldScore = textIncludes(ct.headline, q) || textIncludes(ct.company, q) || textIncludes(ct.title, q) ? 40 : 0;
        const noteScore = noteHitIds.has(ct.id) ? 25 : 0;
        return { ct, score: Math.max(nameScore, fieldScore, noteScore) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.ct.pinned) - Number(a.ct.pinned) || a.ct.name.localeCompare(b.ct.name))
      .map((x) => x.ct);
  }

  return c.json(contacts);
});

app.post('/api/contacts', async (c) => {
  const body = await c.req.json<Partial<Contact>>();
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  const id = uid();
  const ts = now();
  const circle = CIRCLES.includes(body.circle as ContactCircle) ? body.circle : 'other';
  await c.env.DB.prepare(
    `INSERT INTO contacts
       (id, name, company, title, circle, emails, phones, address, headline, city,
        birthday_month, birthday_day, birthday_year,
        anniversary_month, anniversary_day, anniversary_year,
        pinned, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?, ?)`
  )
    .bind(
      id,
      body.name.trim(),
      body.company ?? null,
      body.title ?? null,
      circle,
      JSON.stringify(body.emails ?? []),
      JSON.stringify(body.phones ?? []),
      body.address ?? null,
      body.headline ?? null,
      body.city ?? null,
      body.birthday_month ?? null,
      body.birthday_day ?? null,
      body.birthday_year ?? null,
      body.anniversary_month ?? null,
      body.anniversary_day ?? null,
      body.anniversary_year ?? null,
      ts,
      ts
    )
    .run();
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<Contact>();
  return c.json(contact, 201);
});

// GET /api/contacts/duplicates — finds likely duplicate pairs already
// sitting in the database (as opposed to /api/contacts/import/preview's
// matching, which only runs against a file being imported right now).
// Groups every contact by nameMatchKey and reports a candidate wherever
// exactly one PERSONAL contact (source != 'voter_file') shares a key with
// one or more standalone voter-roll contacts. Deliberately skips a key
// where more than one personal contact collides — that's ambiguous (which
// one is the real match?) and not safe to suggest automatically. Doesn't
// touch anything itself; each candidate still needs the one-click Merge
// action (POST /api/contacts/:id/merge) to actually combine them, since
// name-only matching can be wrong — most often two different people who
// share a name (a parent and child, most commonly).
//
// Registered BEFORE /api/contacts/:id below: a static "/duplicates" segment
// and the ":id" param route are at the same path depth, and in practice
// this router matches whichever is registered first rather than always
// preferring the static route — so this has to come first or every request
// here gets swallowed by the :id handler as a "contact not found".
app.get('/api/contacts/duplicates', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, circle, source FROM contacts').all<{
    id: string;
    name: string;
    circle: string;
    source: string;
  }>();
  const rows = results ?? [];

  const byKey = new Map<string, { personal: typeof rows; voters: typeof rows }>();
  for (const r of rows) {
    const key = nameMatchKey(r.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { personal: [], voters: [] });
    const bucket = byKey.get(key)!;
    if (r.source === 'voter_file') bucket.voters.push(r);
    else bucket.personal.push(r);
  }

  const candidates: { key: string; personal: { id: string; name: string; circle: string }; voters: { id: string; name: string }[] }[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.personal.length === 1 && bucket.voters.length >= 1) {
      candidates.push({
        key,
        personal: { id: bucket.personal[0].id, name: bucket.personal[0].name, circle: bucket.personal[0].circle },
        voters: bucket.voters.map((v) => ({ id: v.id, name: v.name })),
      });
    }
  }
  candidates.sort((a, b) => a.personal.name.localeCompare(b.personal.name));

  return c.json({ candidates });
});

// GET /api/contacts/:id — the contact plus its full note feed (newest
// first) and any voter-file records blended into it. One request for the
// whole detail page rather than a round trip per section.
app.get('/api/contacts/:id', async (c) => {
  const id = c.req.param('id');
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<Contact>();
  if (!contact) return c.json({ error: 'not found' }, 404);
  const { results: notes } = await c.env.DB.prepare('SELECT * FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC')
    .bind(id)
    .all<ContactNote>();
  const { results: voterRecords } = await c.env.DB.prepare('SELECT * FROM voter_records WHERE contact_id = ? ORDER BY created_at DESC')
    .bind(id)
    .all<VoterRecord>();

  // Connections show on both people's cards from one entry — a row
  // created as A -> B ("A's Spouse is B") is fetched here whether we're
  // looking at A (direction 'from') or B (direction 'to'). The label
  // reads the same either way (a real "reverse label" like Spouse->Spouse
  // or Kid->Parent would need its own mapping, which felt like more
  // machinery than this needs — the connected person's name makes the
  // direction obvious in context).
  const [{ results: connFrom }, { results: connTo }] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM contact_connections WHERE contact_id = ? ORDER BY created_at ASC').bind(id).all<ContactConnection>(),
    c.env.DB.prepare('SELECT * FROM contact_connections WHERE related_contact_id = ? ORDER BY created_at ASC').bind(id).all<ContactConnection>(),
  ]);
  const connections = [
    ...(connFrom ?? []).map((row) => ({ ...row, direction: 'from' as const })),
    ...(connTo ?? []).map((row) => ({ ...row, direction: 'to' as const })),
  ];

  // Household members, computed live from the voter file rather than
  // stored — see 0031_contact_headline_city_connections.sql and
  // 0018_contact_import.sql's household_code comment. Anyone sharing this
  // contact's household_code(s), across any of their voter_records rows,
  // excluding this contact itself.
  const householdCodes = [...new Set((voterRecords ?? []).map((v) => v.household_code).filter((code): code is string => !!code))];
  let householdMembers: { contactId: string; name: string }[] = [];
  if (householdCodes.length > 0) {
    const placeholders = householdCodes.map(() => '?').join(', ');
    const { results: memberRows } = await c.env.DB.prepare(
      `SELECT DISTINCT c.id, c.name FROM voter_records vr JOIN contacts c ON c.id = vr.contact_id
       WHERE vr.household_code IN (${placeholders}) AND vr.contact_id != ?`
    )
      .bind(...householdCodes, id)
      .all<{ id: string; name: string }>();
    householdMembers = (memberRows ?? []).map((m) => ({ contactId: m.id, name: m.name }));
  }

  return c.json({ ...contact, notes: notes ?? [], voterRecords: voterRecords ?? [], connections, householdMembers });
});

// POST /api/contacts/:id/connections — a manual connection to another
// contact (by id) or just a name (relatedContactId omitted) for someone
// who isn't a saved contact yet — same "a name is enough" latitude Thanks
// Bud's own connections have, since requiring a full contact record first
// would make this useless for "my neighbor's dog-walker, Pat" type notes.
app.post('/api/contacts/:id/connections', async (c) => {
  const contactId = c.req.param('id');
  const body = await c.req.json<{ relatedContactId?: string | null; relatedName?: string; label: string }>();
  if (!body.label?.trim()) return c.json({ error: 'label required' }, 400);

  let relatedName = body.relatedName?.trim() ?? '';
  if (body.relatedContactId) {
    const related = await c.env.DB.prepare('SELECT name FROM contacts WHERE id = ?').bind(body.relatedContactId).first<{ name: string }>();
    if (!related) return c.json({ error: 'related contact not found' }, 404);
    relatedName = related.name;
  }
  if (!relatedName) return c.json({ error: 'relatedContactId or relatedName required' }, 400);

  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO contact_connections (id, contact_id, related_contact_id, related_name, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`
  )
    .bind(id, contactId, body.relatedContactId ?? null, relatedName, body.label.trim(), ts, ts)
    .run();
  const connection = await c.env.DB.prepare('SELECT * FROM contact_connections WHERE id = ?').bind(id).first<ContactConnection>();
  return c.json(connection, 201);
});

app.delete('/api/contacts/:id/connections/:connectionId', async (c) => {
  await c.env.DB.prepare('DELETE FROM contact_connections WHERE id = ? AND contact_id = ?').bind(c.req.param('connectionId'), c.req.param('id')).run();
  return c.json({ ok: true });
});

app.patch('/api/contacts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<Contact>>();
  const existing = await c.env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  // Build the SET clause from whichever fields were actually sent, same
  // partial-update pattern as PATCH /api/entities/:id — a contact's edit
  // form only sends what changed, not the whole record.
  const fields: [string, unknown][] = [];
  const simple: (keyof Contact)[] = [
    'name',
    'company',
    'title',
    'address',
    'headline',
    'city',
    'birthday_month',
    'birthday_day',
    'birthday_year',
    'anniversary_month',
    'anniversary_day',
    'anniversary_year',
  ];
  for (const key of simple) {
    if (key in body) fields.push([key, (body as Record<string, unknown>)[key] ?? null]);
  }
  if (body.circle !== undefined && CIRCLES.includes(body.circle as ContactCircle)) fields.push(['circle', body.circle]);
  if (body.emails !== undefined) fields.push(['emails', JSON.stringify(body.emails)]);
  if (body.phones !== undefined) fields.push(['phones', JSON.stringify(body.phones)]);
  if (body.pinned !== undefined) fields.push(['pinned', body.pinned ? 1 : 0]);

  if (fields.length > 0) {
    fields.push(['updated_at', now()]);
    const setClause = fields.map(([k]) => `${k} = ?`).join(', ');
    await c.env.DB.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`)
      .bind(...fields.map(([, v]) => v), id)
      .run();
  }
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<Contact>();
  return c.json(contact);
});

app.delete('/api/contacts/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM voter_records WHERE contact_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM contact_notes WHERE contact_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// POST /api/contacts/:id/merge — manual duplicate cleanup for the pairs
// nameMatchKey still can't catch on its own (a nickname not in its list,
// a misspelling, two genuinely different-looking names Mike recognizes as
// the same person). `mergeFromId` is folded INTO `:id` and then deleted:
// additive-only onto the surviving contact (same rule as an import merge —
// only fills blank fields, unions emails/phones), and every voter_records/
// contact_notes row moves over rather than getting lost.
app.post('/api/contacts/:id/merge', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ mergeFromId: string }>();
  const mergeFromId = body.mergeFromId;
  if (!mergeFromId || mergeFromId === id) return c.json({ error: 'mergeFromId required and must differ from :id' }, 400);

  const target = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<Contact>();
  const source = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(mergeFromId).first<Contact>();
  if (!target || !source) return c.json({ error: 'contact not found' }, 404);

  const fields: [string, unknown][] = [];
  if (!target.company && source.company) fields.push(['company', source.company]);
  if (!target.title && source.title) fields.push(['title', source.title]);
  if (!target.address && source.address) fields.push(['address', source.address]);
  if (!target.birthday_month && source.birthday_month) {
    fields.push(['birthday_month', source.birthday_month], ['birthday_day', source.birthday_day], ['birthday_year', source.birthday_year]);
  }
  if (!target.anniversary_month && source.anniversary_month) {
    fields.push(['anniversary_month', source.anniversary_month], ['anniversary_day', source.anniversary_day], ['anniversary_year', source.anniversary_year]);
  }

  const targetEmails = JSON.parse(target.emails || '[]') as string[];
  const targetEmailSet = new Set(targetEmails.map(normalizeEmail));
  const sourceEmails = JSON.parse(source.emails || '[]') as string[];
  const mergedEmails = [...targetEmails, ...sourceEmails.filter((e) => !targetEmailSet.has(normalizeEmail(e)))];
  if (mergedEmails.length !== targetEmails.length) fields.push(['emails', JSON.stringify(mergedEmails)]);

  const targetPhones = JSON.parse(target.phones || '[]') as string[];
  const targetPhoneSet = new Set(targetPhones.map(normalizePhone));
  const sourcePhones = JSON.parse(source.phones || '[]') as string[];
  const mergedPhones = [...targetPhones, ...sourcePhones.filter((p) => !targetPhoneSet.has(normalizePhone(p)))];
  if (mergedPhones.length !== targetPhones.length) fields.push(['phones', JSON.stringify(mergedPhones)]);

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  if (fields.length > 0) {
    fields.push(['updated_at', ts]);
    const setClause = fields.map(([k]) => `${k} = ?`).join(', ');
    stmts.push(c.env.DB.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`).bind(...fields.map(([, v]) => v), id));
  }
  stmts.push(c.env.DB.prepare('UPDATE voter_records SET contact_id = ? WHERE contact_id = ?').bind(id, mergeFromId));
  stmts.push(c.env.DB.prepare('UPDATE contact_notes SET contact_id = ? WHERE contact_id = ?').bind(id, mergeFromId));
  stmts.push(c.env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(mergeFromId));
  await c.env.DB.batch(stmts);

  const merged = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first<Contact>();
  return c.json(merged);
});

// POST /api/contacts/:id/notes — the quick-add: one line of freeform text,
// optionally flagged to resurface later. `remind_in_days` is resolved to an
// actual date here (server clock, not the client's) rather than trusting a
// client-computed timestamp.
app.post('/api/contacts/:id/notes', async (c) => {
  const contactId = c.req.param('id');
  const body = await c.req.json<{ text: string; remind_in_days?: number }>();
  if (!body.text?.trim()) return c.json({ error: 'text required' }, 400);
  const contact = await c.env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
  if (!contact) return c.json({ error: 'not found' }, 404);

  const id = uid();
  const ts = now();
  const remindAt = body.remind_in_days
    ? new Date(Date.now() + body.remind_in_days * 24 * 60 * 60 * 1000).toISOString()
    : null;
  await c.env.DB.prepare(
    `INSERT INTO contact_notes (id, contact_id, text, source_type, source_id, remind_at, remind_resolved, created_at)
     VALUES (?, ?, ?, 'quick_note', NULL, ?, 0, ?)`
  )
    .bind(id, contactId, body.text.trim(), remindAt, ts)
    .run();
  const note = await c.env.DB.prepare('SELECT * FROM contact_notes WHERE id = ?').bind(id).first<ContactNote>();
  return c.json(note, 201);
});

// PATCH /api/contacts/:id/notes/:noteId — currently only for resolving
// (dismissing) a check-in reminder once you've acted on it.
app.patch('/api/contacts/:id/notes/:noteId', async (c) => {
  const noteId = c.req.param('noteId');
  const body = await c.req.json<{ remind_resolved?: boolean }>();
  if (body.remind_resolved !== undefined) {
    await c.env.DB.prepare('UPDATE contact_notes SET remind_resolved = ? WHERE id = ?')
      .bind(body.remind_resolved ? 1 : 0, noteId)
      .run();
  }
  const note = await c.env.DB.prepare('SELECT * FROM contact_notes WHERE id = ?').bind(noteId).first<ContactNote>();
  return c.json(note);
});

app.delete('/api/contacts/:id/notes/:noteId', async (c) => {
  const noteId = c.req.param('noteId');
  await c.env.DB.prepare('DELETE FROM contact_notes WHERE id = ?').bind(noteId).run();
  return c.json({ ok: true });
});

// ---- Contact import (CSV / vCard, personal contacts and voter file) ----

interface ParsedContactRecord {
  name: string;
  emails: string[];
  phones: string[];
  address: string | null;
  company: string | null;
  title: string | null;
  circleHint: ContactCircle | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  party: string | null;
  voter_age: number | null;
  household_members: string[] | null;
  voting_history: unknown;
  // Google Contacts' "Relation 1..N - Label/Value" columns — personal
  // contact imports only, always [] for a voter-file row (that format has
  // no such concept). Threaded through to processDecisionChunk, which
  // turns each one into a contact_connections row, matched to an existing
  // contact by name when possible (see resolveRelatedContactId).
  relations: { label: string; name: string }[];
  // Fields added when the Bedford Voter Intelligence app (a separate
  // Cloudflare app Mike already built against this same county voter file)
  // turned out to have a much richer, correctly-labeled breakdown of this
  // same file than this importer's original handful of fields — see
  // 0022_voter_record_fields.sql for the full reasoning per field. All
  // null for a non-voter-file import (personal contacts/vCard).
  gender: string | null;
  registered_date: string | null;
  voter_phone: string | null;
  polling_place: string | null;
  causeway_tag: string | null;
  calculated_party: string | null;
  household_party: string | null;
  household_code: string | null;
  cd: string | null;
  sd: string | null;
  ad: string | null;
  ld: string | null;
  gop_matrix: string | null;
  raw: Record<string, string>;
}

// Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas/
// newlines, and "" as an escaped quote. Not a full spec implementation,
// just enough for real-world exports; no external dependency for
// something this bounded.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Header names vary a lot between Google's CSV export, a county voter
// file, and a hand-made spreadsheet — matched by a normalized alias list
// rather than requiring an exact header, so a differently-worded export
// still imports instead of silently finding nothing.
function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
}

function findColumn(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  for (const alias of aliases) {
    const idx = normalized.findIndex((h) => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

function splitMulti(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Google Contacts' own multi-value "Labels"/"Group Membership" column uses
// " ::: " between group names (e.g. "* myContacts ::: Family ::: Golf
// Buddies"), not a comma or semicolon — splitMulti would treat the whole
// thing as one label, which never matches a plain "family" against
// CIRCLE_ALIASES. Split on both so a contact's real group memberships are
// actually visible to circleFromLabel one at a time.
function splitLabels(value: string): string[] {
  return value
    .split(/\s*:::\s*|[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Best-effort date parsing for whatever format a birthday/DOB column shows
// up in (MM/DD/YYYY, YYYY-MM-DD, "March 3 1990", ...) — falls back to null
// rather than throwing, since a malformed date shouldn't sink the row.
function parseDateParts(value: string): { month: number | null; day: number | null; year: number | null } {
  const trimmed = value.trim();
  if (!trimmed) return { month: null, day: null, year: null };
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return { month: +m[1], day: +m[2], year };
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return { month: parsed.getMonth() + 1, day: parsed.getDate(), year: parsed.getFullYear() };
  }
  return { month: null, day: null, year: null };
}

const CIRCLE_ALIASES: Record<string, ContactCircle> = {
  family: 'family',
  friends: 'friends',
  friend: 'friends',
  neighbors: 'neighbors',
  neighbor: 'neighbors',
  community: 'community',
  professional: 'professional',
  work: 'professional',
  colleagues: 'professional',
};

// Google/Apple/Samsung "labels"/"categories" become circles for free on
// import, rather than everyone landing in 'other' and needing manual
// re-sorting — this is what lets an already-organized address book carry
// its structure straight over.
function circleFromLabel(labels: string[]): ContactCircle | null {
  for (const label of labels) {
    const hit = CIRCLE_ALIASES[label.toLowerCase().trim()];
    if (hit) return hit;
  }
  return null;
}

// Parses a Google-style (or similar) contacts CSV export. Column presence
// varies by export vintage/source, so every column is looked up by alias.
function parseContactsCsv(text: string): ParsedContactRecord[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  // firstIdx/lastIdx are found BEFORE nameIdx, and take priority when both
  // are present — findColumn's generic 'name' alias matches by substring
  // when there's no exact "Name" column, and "First Name"/"Last Name" (a
  // real Google Contacts export never has a literal "Name" column, only
  // these) both contain "name" as a substring. Checking 'name' first meant
  // it always matched the *First Name* column and never got as far as
  // looking for Last Name at all — every imported contact silently lost
  // their last name. See also findColumn's own exact-match-first, then
  // substring-fallback order, which is what makes this collision possible.
  const firstIdx = findColumn(headers, ['first name', 'given name']);
  const lastIdx = findColumn(headers, ['last name', 'family name']);
  const nameIdx = findColumn(headers, ['full name', 'display name', 'name']);
  const emailIdx = findColumn(headers, ['e mail 1 value', 'email', 'e mail']);
  const phoneIdx = findColumn(headers, ['phone 1 value', 'phone', 'phone number']);
  const companyIdx = findColumn(headers, ['organization 1 name', 'company', 'organization']);
  const titleIdx = findColumn(headers, ['organization 1 title', 'title', 'job title']);
  const addressIdx = findColumn(headers, ['address 1 formatted', 'address', 'street address']);
  const birthdayIdx = findColumn(headers, ['birthday']);
  const labelsIdx = findColumn(headers, ['labels', 'group membership', 'category', 'categories']);
  // Google Contacts' export numbers relation columns 1..N as separate
  // "Relation N - Label"/"Relation N - Value" pairs (occasionally "Type"
  // instead of "Label" in older exports) — scanned up to a generous cap
  // rather than a fixed count, since how many a contact has varies and an
  // unused slot's columns are just blank.
  const RELATION_SLOTS = 15;
  const relationIdxPairs: [number, number][] = [];
  for (let i = 1; i <= RELATION_SLOTS; i++) {
    const labelIdx = findColumn(headers, [`relation ${i} label`, `relation ${i} type`]);
    const valueIdx = findColumn(headers, [`relation ${i} value`]);
    if (labelIdx >= 0 && valueIdx >= 0) relationIdxPairs.push([labelIdx, valueIdx]);
  }

  const records: ParsedContactRecord[] = [];
  for (const row of rows.slice(1)) {
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');
    const fromParts = [get(firstIdx), get(lastIdx)].filter(Boolean).join(' ');
    const name = fromParts || (nameIdx >= 0 ? get(nameIdx) : '');
    if (!name) continue;
    const bday = birthdayIdx >= 0 ? parseDateParts(get(birthdayIdx)) : { month: null, day: null, year: null };
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => (raw[h] = row[i] ?? ''));
    const relations = relationIdxPairs
      .map(([labelIdx, valueIdx]) => ({ label: get(labelIdx) || 'Related', name: get(valueIdx) }))
      .filter((r) => r.name);
    records.push({
      name,
      emails: emailIdx >= 0 ? splitMulti(get(emailIdx)) : [],
      phones: phoneIdx >= 0 ? splitMulti(get(phoneIdx)) : [],
      address: addressIdx >= 0 ? get(addressIdx) || null : null,
      company: companyIdx >= 0 ? get(companyIdx) || null : null,
      title: titleIdx >= 0 ? get(titleIdx) || null : null,
      circleHint: labelsIdx >= 0 ? circleFromLabel(splitLabels(get(labelsIdx))) : null,
      birthday_month: bday.month,
      birthday_day: bday.day,
      birthday_year: bday.year,
      party: null,
      voter_age: null,
      household_members: null,
      voting_history: null,
      relations,
      gender: null,
      registered_date: null,
      voter_phone: null,
      polling_place: null,
      causeway_tag: null,
      calculated_party: null,
      household_party: null,
      household_code: null,
      cd: null,
      sd: null,
      ad: null,
      ld: null,
      gop_matrix: null,
      raw,
    });
  }
  return records;
}

// Identity/geo columns this importer deliberately doesn't promote to a
// dedicated field — still preserved in raw_data, just excluded from the
// leftover "everything else is vote history" scan below (by normalized
// header text) so they don't show up mislabeled as election chips.
const VOTER_HISTORY_IGNORE_HEADERS = new Set([
  'id', 'voterid', 'firstname', 'lastname', 'name middle', 'name last/first',
  'address d/s/t/p', 'full address', 'full name', 'addr num', 'addr str',
  'addr type', 'addr city', 'addr state', 'addr zip', '0t/w/d', 'town code',
  'ward code', 'ed code', 'status', 'vsn numeric', 'nysvoterid',
  'ethnicity 1', 'ethnicity 5', 'town/city name', 'modeledethnicity',
  'ny gop legislativematrix',
]);

type VoterFields = Pick<
  ParsedContactRecord,
  | 'address'
  | 'birthday_month'
  | 'birthday_day'
  | 'birthday_year'
  | 'party'
  | 'voter_age'
  | 'household_members'
  | 'voting_history'
  | 'gender'
  | 'registered_date'
  | 'voter_phone'
  | 'polling_place'
  | 'causeway_tag'
  | 'calculated_party'
  | 'household_party'
  | 'household_code'
  | 'cd'
  | 'sd'
  | 'ad'
  | 'ld'
  | 'gop_matrix'
>;

// Looks up a value in a raw header->value row by alias, same exact-then-
// substring matching findColumn does for a CSV header array, just keyed by
// object key instead of array index — the shared shape underneath both
// parseVoterCsv (fresh import) and the voter-fields backfill (re-parsing
// an already-imported row's stored raw_data) below.
// Bedford's export escapes date-/leading-zero-sensitive values as Excel
// "text" formulas (e.g. REG_DT's raw cell is literally "=09/22/1987", not
// "09/22/1987") so Excel doesn't reformat or truncate them. That leading
// "=" is a source-file export artifact, not real data — strip it before
// the value is ever shown or stored as a promoted field.
function stripCsvFormulaEscape(value: string): string {
  return value.startsWith('=') ? value.slice(1) : value;
}

function findRawValue(raw: Record<string, string>, aliases: string[]): string | null {
  const keys = Object.keys(raw);
  const normalized = keys.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) {
      const v = raw[keys[idx]]?.trim();
      return v ? stripCsvFormulaEscape(v) : null;
    }
  }
  for (const alias of aliases) {
    const idx = normalized.findIndex((h) => h.includes(alias));
    if (idx !== -1) {
      const v = raw[keys[idx]]?.trim();
      return v ? stripCsvFormulaEscape(v) : null;
    }
  }
  return null;
}

// The actual field-mapping logic for Bedford's county voter file — shared
// by parseVoterCsv (a fresh import) and the voter-fields backfill endpoint
// (re-parsing an already-imported voter contact's stored raw_data with
// this same, corrected mapping) so the two can never drift apart. Column
// names confirmed against a real export, not guessed — see the comment on
// 0022_voter_record_fields.sql for the full story of why several of these
// replace what this importer originally, incorrectly matched.
function extractVoterFields(raw: Record<string, string>): VoterFields {
  const keys = Object.keys(raw);
  const normalized = keys.map(normalizeHeader);

  // Prefer the pre-combined, house-number-included address; fall back to
  // whatever single "address"-ish column exists for a file shaped
  // differently than this one. (findRawValue's substring fallback used to
  // land on ADDRESS D/S/T/P first — street name only, no house number —
  // which is why this used to silently drop it.)
  const addressLine1 = findRawValue(raw, ['addressline1']);
  const city = findRawValue(raw, ['city']);
  const state = findRawValue(raw, ['state']);
  const zip = findRawValue(raw, ['zipcode']);
  // Standard US postal format: "Street, City, State Zip" — state and zip
  // are joined with a space, not a comma, unlike the other parts.
  const stateZip = [state, zip].filter(Boolean).join(' ');
  const combinedAddress = [addressLine1, city, stateZip].filter(Boolean).join(', ');
  const address = addressLine1 && combinedAddress ? combinedAddress : findRawValue(raw, ['full address', 'address', 'residence address', 'street address']);

  const dobRaw = findRawValue(raw, ['birthdate', 'date of birth', 'dob', 'birthday', 'birth date']);
  const bday = dobRaw ? parseDateParts(dobRaw) : { month: null, day: null, year: null };
  const ageRaw = findRawValue(raw, ['age']);
  const ageVal = ageRaw ? parseInt(ageRaw, 10) : NaN;
  const historyRaw = findRawValue(raw, ['voting history', 'vote history', 'elections voted']);

  // Column names actually consumed above — tracked by re-deriving which
  // key findRawValue picked for each alias set (rather than a fixed text
  // list) so this can't drift out of sync with a column matched via the
  // substring fallback (e.g. "age" lands on "AGE LAST 12/31", not
  // literally "age" — a plain text exclusion list would miss that and let
  // it leak through as a duplicate vote-history chip).
  const consumeKeys = (aliases: string[]) => {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) return keys[idx];
    }
    for (const alias of aliases) {
      const idx = normalized.findIndex((h) => h.includes(alias));
      if (idx !== -1) return keys[idx];
    }
    return null;
  };
  const consumed = new Set(
    [
      consumeKeys(['addressline1']), consumeKeys(['city']), consumeKeys(['state']), consumeKeys(['zipcode']),
      consumeKeys(['full address', 'address', 'residence address', 'street address']),
      consumeKeys(['birthdate', 'date of birth', 'dob', 'birthday', 'birth date']), consumeKeys(['age']),
      consumeKeys(['voting history', 'vote history', 'elections voted']),
      consumeKeys(['party', 'party affiliation', 'party registration']), consumeKeys(['gender']),
      consumeKeys(['reg dt', 'registered', 'registration date']), consumeKeys(['tel dialer 1', 'phone', 'telephone']),
      consumeKeys(['polling place']), consumeKeys(['causeway tag']),
      consumeKeys(['calculatedparty', 'calculated party']), consumeKeys(['householdparty', 'household party']),
      consumeKeys(['household code']), consumeKeys(['cd']), consumeKeys(['sd']), consumeKeys(['ad']), consumeKeys(['ld']),
      consumeKeys(['genericmatrix', 'gop matrix']),
    ].filter((k): k is string => k !== null)
  );

  // Everything not already promoted to a named field above is treated as
  // election/vote-history data — this file has dozens of per-election
  // columns (general, primary, special) rather than one combined "voting
  // history" column, and new elections just add more columns over time,
  // so a fixed list here would go stale. Order follows the file's own
  // column order. Blank values are already excluded (a cell for an
  // election this person didn't vote in is blank in the source file).
  const voteHistory: { code: string; value: string }[] = [];
  keys.forEach((k, i) => {
    if (consumed.has(k) || VOTER_HISTORY_IGNORE_HEADERS.has(normalized[i])) return;
    const v = (raw[k] ?? '').trim();
    if (!v) return;
    voteHistory.push({ code: k, value: v });
  });

  return {
    address,
    birthday_month: bday.month,
    birthday_day: bday.day,
    birthday_year: bday.year,
    party: findRawValue(raw, ['party', 'party affiliation', 'party registration']),
    voter_age: Number.isFinite(ageVal) ? ageVal : null,
    // The real per-row "household" data this file has is a shared
    // HOUSEHOLD CODE (matched against other rows) and a household-level
    // party lean — not a list of member names in this cell. Building the
    // actual cross-referenced member list (name/party/age of everyone
    // sharing a household code, like the other app shows) is deferred;
    // household_code is still captured now so that later work doesn't
    // need a re-import to get it.
    household_members: null,
    voting_history: voteHistory.length > 0 ? voteHistory : null,
    gender: findRawValue(raw, ['gender']),
    registered_date: findRawValue(raw, ['reg dt', 'registered', 'registration date']),
    voter_phone: findRawValue(raw, ['tel dialer 1', 'phone', 'telephone']),
    polling_place: findRawValue(raw, ['polling place']),
    causeway_tag: findRawValue(raw, ['causeway tag']),
    calculated_party: findRawValue(raw, ['calculatedparty', 'calculated party']),
    household_party: findRawValue(raw, ['householdparty', 'household party']),
    household_code: findRawValue(raw, ['household code']),
    cd: findRawValue(raw, ['cd']),
    sd: findRawValue(raw, ['sd']),
    ad: findRawValue(raw, ['ad']),
    ld: findRawValue(raw, ['ld']),
    gop_matrix: findRawValue(raw, ['genericmatrix', 'gop matrix']),
  };
}

// Parses a voter-file CSV — same alias-matching approach as the personal-
// contact importer above, but delegates the actual field mapping to
// extractVoterFields so a fresh import and the backfill endpoint (which
// re-parses an already-imported row's stored raw_data) can never drift
// apart.
function parseVoterCsv(text: string): ParsedContactRecord[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const nameIdx = findColumn(headers, ['name', 'voter name', 'full name']);
  const firstIdx = findColumn(headers, ['first name']);
  const lastIdx = findColumn(headers, ['last name']);

  const records: ParsedContactRecord[] = [];
  for (const row of rows.slice(1)) {
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');
    const rawName = nameIdx >= 0 ? get(nameIdx) : [get(firstIdx), get(lastIdx)].filter(Boolean).join(' ');
    if (!rawName) continue;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => (raw[h] = row[i] ?? ''));
    const fields = extractVoterFields(raw);

    records.push({
      // Display name is cleaned up (no honorific, no middle initial, Title
      // Case instead of the file's ALL CAPS) — see cleanVoterDisplayName's
      // comment. The untouched original is still preserved in `raw` below,
      // which lands in voter_records.raw_data.
      name: cleanVoterDisplayName(rawName),
      emails: [],
      phones: [],
      company: null,
      title: null,
      circleHint: null,
      relations: [],
      ...fields,
      raw,
    });
  }
  return records;
}

// Parses a vCard (.vcf) export — the format Apple Contacts, Samsung
// Contacts, and Outlook all use (Google can export it too). A pragmatic
// subset of RFC 6350 — FN/N, EMAIL, TEL, ADR, ORG, TITLE, BDAY,
// CATEGORIES — covering what these apps actually export, not the full
// spec. Multiple vCards concatenated in one file (the usual "export all
// contacts" shape) are split on BEGIN:VCARD.
function parseVCard(text: string): ParsedContactRecord[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const records: ParsedContactRecord[] = [];
  for (const card of cards) {
    const lines = card
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let name = '';
    let org = '';
    let title = '';
    let address: string | null = null;
    const emails: string[] = [];
    const phones: string[] = [];
    let categories: string[] = [];
    let bday = { month: null as number | null, day: null as number | null, year: null as number | null };
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1).trim();
      const key = keyPart.split(';')[0].toUpperCase();
      if (key === 'FN') name = value;
      else if (key === 'N' && !name) name = value.split(';').filter(Boolean).reverse().join(' ');
      else if (key === 'EMAIL') emails.push(value);
      else if (key === 'TEL') phones.push(value);
      else if (key === 'ORG') org = value.split(';')[0];
      else if (key === 'TITLE') title = value;
      else if (key === 'ADR') address = value.split(';').filter(Boolean).join(', ');
      else if (key === 'BDAY') bday = parseDateParts(value);
      else if (key === 'CATEGORIES') categories = splitMulti(value);
    }
    if (!name) continue;
    records.push({
      name,
      emails,
      phones,
      address,
      company: org || null,
      title: title || null,
      circleHint: circleFromLabel(categories),
      birthday_month: bday.month,
      birthday_day: bday.day,
      birthday_year: bday.year,
      party: null,
      voter_age: null,
      household_members: null,
      voting_history: null,
      relations: [],
      gender: null,
      registered_date: null,
      voter_phone: null,
      polling_place: null,
      causeway_tag: null,
      calculated_party: null,
      household_party: null,
      household_code: null,
      cd: null,
      sd: null,
      ad: null,
      ld: null,
      gop_matrix: null,
      raw: { name, org, title, address: address ?? '', emails: emails.join(';'), phones: phones.join(';') },
    });
  }
  return records;
}

function normalizeEmail(e: string): string {
  return e.toLowerCase().trim();
}

function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

function normalizeName(n: string): string {
  return n.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Bedford's voter file names as "FIRST MIDDLE LAST" (e.g. "ARI R ABBOUD"),
// middle initial included — a personal contact from Google is almost never
// going to have that middle initial ("Ari Abboud"), so a plain normalized
// string comparison missed the great majority of real matches between the
// two files. Reducing to just the first and last token (dropping anything
// in between) is what actually lines these up. This only widens what
// surfaces in the "review" queue for a one-click same-person/different-
// person decision — it never auto-merges on its own, so a loosened match
// is a safe trade: worse case is one extra click, not a wrong merge.
const NAME_HONORIFICS = new Set(['hon', 'dr', 'mr', 'mrs', 'ms', 'miss', 'rev', 'prof', 'sen', 'rep', 'capt', 'col', 'gen', 'sgt']);
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'esq', 'phd', 'md']);

// A handful of common nickname/formal-name pairs — enough that "Greg"
// matches "Gregory" and "Mike" matches "Michael" without needing a huge
// dictionary. Deliberately biased toward older/traditional names, since a
// county voter roll skews that way far more than a friends-and-family
// address book does. Every entry maps to one canonical form so either
// spelling normalizes the same way.
const NICKNAME_CANON: Record<string, string> = {
  mike: 'michael', mikey: 'michael',
  greg: 'gregory',
  bob: 'robert', bobby: 'robert', rob: 'robert', robbie: 'robert',
  bill: 'william', billy: 'william', will: 'william',
  liz: 'elizabeth', beth: 'elizabeth', betty: 'elizabeth', eliza: 'elizabeth', lisa: 'elizabeth', betsy: 'elizabeth',
  tom: 'thomas', tommy: 'thomas',
  jim: 'james', jimmy: 'james', jamie: 'james',
  dave: 'david', davy: 'david',
  chris: 'christopher', kris: 'christopher',
  steve: 'steven', stevie: 'steven',
  dan: 'daniel', danny: 'daniel',
  ken: 'kenneth', kenny: 'kenneth',
  ed: 'edward', eddie: 'edward', ted: 'edward', teddy: 'edward',
  nick: 'nicholas', nicky: 'nicholas',
  matt: 'matthew',
  sam: 'samuel', sammy: 'samuel',
  tony: 'anthony',
  rich: 'richard', rick: 'richard', ricky: 'richard', dick: 'richard',
  joe: 'joseph', joey: 'joseph',
  jack: 'john', johnny: 'john',
  peggy: 'margaret', maggie: 'margaret', meg: 'margaret',
  sally: 'sarah', sadie: 'sarah',
  molly: 'mary', polly: 'mary',
  kate: 'katherine', katie: 'katherine', kathy: 'katherine', kay: 'katherine', cathy: 'katherine',
  nell: 'cornelia', nellie: 'cornelia',
  gene: 'eugene',
  al: 'albert', bert: 'albert',
  andy: 'andrew', drew: 'andrew',
  ben: 'benjamin', benny: 'benjamin',
  charlie: 'charles', chuck: 'charles',
  frank: 'francis', frankie: 'francis',
  gerry: 'gerald', jerry: 'gerald',
  larry: 'lawrence',
  pat: 'patricia', patty: 'patricia', tricia: 'patricia',
  ron: 'ronald', ronnie: 'ronald',
  vince: 'vincent',
  walt: 'walter',
};

function canonicalFirstName(token: string): string {
  return NICKNAME_CANON[token] ?? token;
}

// Loosens a raw name down to a first+last comparison key: drops honorifics
// ("Hon.", "Dr.") and generational suffixes ("Jr.", "III") so they don't
// get mistaken for a middle/first token, drops whatever's between the
// first and last name (a voter file's middle initial, most often), and
// canonicalizes common nicknames so "Greg"/"Gregory" and "Mike"/"Michael"
// compare equal. Only widens the review queue — see matchRecords — never
// auto-merges on its own, so a broader match here is a safe trade.
function nameMatchKey(n: string): string {
  const parts = normalizeName(n)
    .replace(/[.,]/g, '')
    .split(' ')
    .filter((p) => p && !NAME_HONORIFICS.has(p) && !NAME_SUFFIXES.has(p));
  if (parts.length === 0) return '';
  if (parts.length === 1) return canonicalFirstName(parts[0]);
  return `${canonicalFirstName(parts[0])} ${parts[parts.length - 1]}`;
}

// Title-cases one word ("PALLADINO" -> "Palladino"), capitalizing after an
// apostrophe or hyphen too ("O'BRIEN" -> "O'Brien", "SMITH-JONES" ->
// "Smith-Jones"). No dictionary of name-specific exceptions (won't get
// "McDonald" — becomes "Mcdonald") — a plain, predictable rule beats a
// half-covered list of special cases here.
function titleCaseWord(word: string): string {
  return word.toLowerCase().replace(/(^|['-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

function titleCaseName(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ');
}

// Turns a raw voter-file name ("HON. MICHAEL A. PALLADINO") into the same
// shape a personal contact's name normally has ("Michael Palladino") —
// drops honorifics/suffixes and any middle name/initial (same reduction as
// nameMatchKey, just applied to what's actually STORED and DISPLAYED, not
// only used for comparison), then title-cases it instead of leaving it
// however the source file capitalized it (voter rolls are typically ALL
// CAPS). The full original value is never lost — it's still in
// voter_records.raw_data — this only changes the Contact.name shown on the
// card and in lists. Used both for brand-new voter-sourced contacts at
// import time and for the one-time bulk cleanup of ones already imported
// (see POST /api/contacts/voter-names/cleanup-chunk).
function cleanVoterDisplayName(raw: string): string {
  const parts = raw
    .trim()
    .replace(/[.,]/g, '')
    .split(/\s+/)
    .filter((p) => p && !NAME_HONORIFICS.has(p.toLowerCase()) && !NAME_SUFFIXES.has(p.toLowerCase()));
  if (parts.length === 0) return titleCaseName(raw);
  const core = parts.length <= 2 ? parts : [parts[0], parts[parts.length - 1]];
  return titleCaseName(core.join(' '));
}

interface ImportMatch {
  record: ParsedContactRecord;
  matchType: 'auto' | 'review' | 'new';
  existingContactId?: string;
  existingName?: string;
}

// Matching policy — deliberately simple, field-equality only, no fuzzy
// scoring: an exact email or phone match is confident enough to merge
// automatically; an exact normalized-name match with no matching contact
// info could be the same person or two different people sharing a common
// name, so it queues for a one-click review instead of guessing; anything
// else becomes a new contact. Everything happens in memory against the
// full contacts table rather than one query per row, since even a
// several-thousand-row voter file is small next to a per-row round trip.
async function matchRecords(db: D1Database, records: ParsedContactRecord[]): Promise<ImportMatch[]> {
  const { results: existing } = await db
    .prepare('SELECT id, name, emails, phones FROM contacts')
    .all<{ id: string; name: string; emails: string; phones: string }>();
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const c of existing ?? []) {
    for (const e of JSON.parse(c.emails || '[]') as string[]) byEmail.set(normalizeEmail(e), c.id);
    for (const p of JSON.parse(c.phones || '[]') as string[]) byPhone.set(normalizePhone(p), c.id);
    byName.set(nameMatchKey(c.name), c.id);
    nameOf.set(c.id, c.name);
  }

  return records.map((record) => {
    for (const e of record.emails) {
      const hit = byEmail.get(normalizeEmail(e));
      if (hit) return { record, matchType: 'auto' as const, existingContactId: hit, existingName: nameOf.get(hit) };
    }
    for (const p of record.phones) {
      const hit = byPhone.get(normalizePhone(p));
      if (hit) return { record, matchType: 'auto' as const, existingContactId: hit, existingName: nameOf.get(hit) };
    }
    const nameHit = byName.get(nameMatchKey(record.name));
    if (nameHit) return { record, matchType: 'review' as const, existingContactId: nameHit, existingName: nameOf.get(nameHit) };
    return { record, matchType: 'new' as const };
  });
}

// POST /api/contacts/import/preview — parses and matches without writing
// anything, so Settings can show counts and the review queue before
// anything touches the database.
app.post('/api/contacts/import/preview', async (c) => {
  const body = await c.req.json<{ content: string; filename: string; kind: 'contacts' | 'voter_file' }>();
  if (!body.content) return c.json({ error: 'content required' }, 400);
  const isVCard = /BEGIN:VCARD/i.test(body.content.slice(0, 2000)) || /\.vcf$/i.test(body.filename);

  const records = body.kind === 'voter_file' ? parseVoterCsv(body.content) : isVCard ? parseVCard(body.content) : parseContactsCsv(body.content);
  if (records.length === 0) {
    return c.json({ error: "No rows recognized — check the file has a header row with a name column, or that it's a valid vCard export" }, 400);
  }

  const matches = await matchRecords(c.env.DB, records);
  return c.json({
    kind: body.kind,
    filename: body.filename,
    totalRows: records.length,
    auto: matches.filter((m) => m.matchType === 'auto'),
    review: matches.filter((m) => m.matchType === 'review'),
    fresh: matches.filter((m) => m.matchType === 'new'),
  });
});

// Import commits are chunked into three steps (start / chunk / finish)
// instead of one request processing the whole file. The original
// single-request version died in production on a 12,109-row voter file —
// sequential per-row awaits with nothing chunked or batched meant the
// request just ran until something (a platform time limit, a dropped
// connection) killed it partway through, and since the import_batches
// summary row was only written at the very end, the failure left 192 real
// contacts in the database with zero trace that anything had gone wrong.
// The fix: create the batch row up front as 'in_progress' so a crash is
// visible instead of silent, and let the client drive bounded-size chunks
// so no single request can run long enough to hit that limit again.
type ImportDecision = { record: ParsedContactRecord; action: 'merge' | 'new'; contactId?: string };

// Processes one bounded slice of decisions. 'new' rows (the common case
// for a first-time import) are inserted via a single atomic db.batch()
// call instead of one awaited statement per row — far fewer network round
// trips, and all-or-nothing for that slice. 'merge' rows still need a
// SELECT before deciding what to write (the additive-only-merge logic
// depends on the existing row's current values), so those stay sequential
// — but they're typically a small fraction of any chunk.
async function processDecisionChunk(
  db: D1Database,
  kind: 'contacts' | 'voter_file',
  decisions: ImportDecision[],
  batchId: string,
  ts: string
): Promise<{ newCount: number; updatedCount: number }> {
  let newCount = 0;
  let updatedCount = 0;
  const newStmts: D1PreparedStatement[] = [];

  // A name->id lookup for resolving Google Contacts "Relation" values back
  // to an existing contact — built once per chunk (not once per relation)
  // since the contacts table is small enough to just scan (same trade the
  // rest of this file already makes for contacts-scale data). Only sees
  // contacts that existed before this chunk started, so two people who
  // reference each other and both arrive in the very same import don't
  // resolve to one another — an acceptable gap given how rarely that
  // exact case comes up, versus the common case of linking a new import
  // row to someone already in MikeOS.
  const nameToContactId = new Map<string, string>();
  if (decisions.some((d) => d.record.relations.length > 0)) {
    const { results: existingContacts } = await db.prepare('SELECT id, name FROM contacts').all<{ id: string; name: string }>();
    for (const ec of existingContacts ?? []) {
      const key = nameMatchKey(ec.name);
      if (key) nameToContactId.set(key, ec.id);
    }
  }

  function queueRelationStmts(contactId: string, relations: { label: string; name: string }[]) {
    for (const rel of relations) {
      const relatedId = nameToContactId.get(nameMatchKey(rel.name)) ?? null;
      newStmts.push(
        db
          .prepare('INSERT INTO contact_connections (id, contact_id, related_contact_id, related_name, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(uid(), contactId, relatedId, rel.name, rel.label, 'import', ts, ts)
      );
    }
  }

  for (const decision of decisions) {
    const r = decision.record;

    if (decision.action === 'merge' && decision.contactId) {
      const contactId = decision.contactId;
      if (r.relations.length > 0) queueRelationStmts(contactId, r.relations);
      const existing = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first<Contact>();
      if (existing) {
        const fields: [string, unknown][] = [];
        if (!existing.company && r.company) fields.push(['company', r.company]);
        if (!existing.title && r.title) fields.push(['title', r.title]);
        if (!existing.address && r.address) fields.push(['address', r.address]);
        if (!existing.birthday_month && r.birthday_month) {
          fields.push(['birthday_month', r.birthday_month], ['birthday_day', r.birthday_day], ['birthday_year', r.birthday_year]);
        }
        const existingEmails = JSON.parse(existing.emails || '[]') as string[];
        const existingEmailSet = new Set(existingEmails.map(normalizeEmail));
        const mergedEmails = [...existingEmails, ...r.emails.filter((e) => !existingEmailSet.has(normalizeEmail(e)))];
        if (mergedEmails.length !== existingEmails.length) fields.push(['emails', JSON.stringify(mergedEmails)]);

        const existingPhones = JSON.parse(existing.phones || '[]') as string[];
        const existingPhoneSet = new Set(existingPhones.map(normalizePhone));
        const mergedPhones = [...existingPhones, ...r.phones.filter((p) => !existingPhoneSet.has(normalizePhone(p)))];
        if (mergedPhones.length !== existingPhones.length) fields.push(['phones', JSON.stringify(mergedPhones)]);

        if (fields.length > 0) {
          fields.push(['updated_at', ts]);
          const setClause = fields.map(([k]) => `${k} = ?`).join(', ');
          await db
            .prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`)
            .bind(...fields.map(([, v]) => v), contactId)
            .run();
          updatedCount++;
        }
      }
      if (kind === 'voter_file') {
        newStmts.push(voterRecordInsertStmt(db, contactId, r, batchId, ts));
      }
    } else {
      // A row that doesn't match anyone becomes its own new contact — for
      // a voter-file row this is the expected common case, not an error,
      // but it's tagged source 'voter_file' rather than 'manual' so it
      // stays out of circles/reach-out nudges meant for people Mike
      // actually knows (see ContactsListPage's default view).
      const contactId = uid();
      newStmts.push(
        db
          .prepare(
            `INSERT INTO contacts
               (id, name, company, title, circle, emails, phones, address,
                birthday_month, birthday_day, birthday_year,
                anniversary_month, anniversary_day, anniversary_year,
                pinned, source, import_batch_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?)`
          )
          .bind(
            contactId,
            r.name,
            r.company,
            r.title,
            r.circleHint ?? 'other',
            JSON.stringify(r.emails),
            JSON.stringify(r.phones),
            r.address,
            r.birthday_month,
            r.birthday_day,
            r.birthday_year,
            kind === 'voter_file' ? 'voter_file' : 'contact_import',
            batchId,
            ts,
            ts
          )
      );
      newCount++;
      if (kind === 'voter_file') {
        newStmts.push(voterRecordInsertStmt(db, contactId, r, batchId, ts));
      }
      if (r.relations.length > 0) queueRelationStmts(contactId, r.relations);
    }
  }

  if (newStmts.length > 0) await db.batch(newStmts);
  return { newCount, updatedCount };
}

// Shared by both the merge and brand-new-contact paths above — a voter-file
// row always gets its own voter_records row either way, only whether the
// *contact* itself is new or matched differs.
function voterRecordInsertStmt(db: D1Database, contactId: string, r: ParsedContactRecord, batchId: string, ts: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO voter_records
         (id, contact_id, party, voter_age, household_members, voting_history,
          gender, registered_date, phone, polling_place, causeway_tag,
          calculated_party, household_party, household_code, cd, sd, ad, ld, gop_matrix,
          raw_data, import_batch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      uid(),
      contactId,
      r.party,
      r.voter_age,
      r.household_members ? JSON.stringify(r.household_members) : null,
      r.voting_history ? JSON.stringify(r.voting_history) : null,
      r.gender,
      r.registered_date,
      r.voter_phone,
      r.polling_place,
      r.causeway_tag,
      r.calculated_party,
      r.household_party,
      r.household_code,
      r.cd,
      r.sd,
      r.ad,
      r.ld,
      r.gop_matrix,
      JSON.stringify(r.raw),
      batchId,
      ts,
      ts
    );
}

// POST /api/contacts/import/commit/start — creates the batch row
// immediately, before any record is written, as 'in_progress'. This is
// what makes an incomplete import visible instead of silent: even if
// every following chunk request fails, Settings can show "this import
// never finished" instead of nothing at all.
app.post('/api/contacts/import/commit/start', async (c) => {
  const body = await c.req.json<{ kind: 'contacts' | 'voter_file'; filename: string; totalRows: number }>();
  const batchId = uid();
  await c.env.DB.prepare(
    'INSERT INTO import_batches (id, kind, filename, new_count, updated_count, status, total_rows, created_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)'
  )
    .bind(batchId, body.kind, body.filename, 'in_progress', body.totalRows ?? null, now())
    .run();
  return c.json({ batchId });
});

// POST /api/contacts/import/commit/chunk — processes one bounded slice of
// decisions (the client keeps chunks small, e.g. ~150 rows) and adds this
// chunk's counts onto the batch's running total.
app.post('/api/contacts/import/commit/chunk', async (c) => {
  const body = await c.req.json<{ batchId: string; kind: 'contacts' | 'voter_file'; decisions: ImportDecision[] }>();
  if (!body.batchId) return c.json({ error: 'batchId required' }, 400);
  if (!body.decisions?.length) return c.json({ error: 'no decisions' }, 400);

  const ts = now();
  const { newCount, updatedCount } = await processDecisionChunk(c.env.DB, body.kind, body.decisions, body.batchId, ts);

  await c.env.DB.prepare('UPDATE import_batches SET new_count = new_count + ?, updated_count = updated_count + ? WHERE id = ?')
    .bind(newCount, updatedCount, body.batchId)
    .run();

  return c.json({ newCount, updatedCount });
});

// POST /api/contacts/import/commit/finish — marks the batch complete once
// every chunk has been sent. A batch left 'in_progress' means the client
// stopped partway (closed the tab, lost connection, hit an error) — the
// data already written is real, but Settings can flag it as incomplete
// rather than presenting it as a normal finished import.
app.post('/api/contacts/import/commit/finish', async (c) => {
  const body = await c.req.json<{ batchId: string }>();
  if (!body.batchId) return c.json({ error: 'batchId required' }, 400);
  await c.env.DB.prepare("UPDATE import_batches SET status = 'complete' WHERE id = ?").bind(body.batchId).run();
  const batch = await c.env.DB.prepare('SELECT * FROM import_batches WHERE id = ?').bind(body.batchId).first<ImportBatch>();
  return c.json(batch);
});

app.get('/api/contacts/import/history', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 20').all<ImportBatch>();
  return c.json(results ?? []);
});

// DELETE /api/contacts/import/batch/:id — undo a whole import. Only ever
// deletes contacts newly CREATED by that batch (import_batch_id = :id);
// a contact that already existed and just got fields filled in by that
// import is untouched, since undoing "filled in a blank email" isn't safe
// to do automatically and isn't what this is for. Exists so a parsing bug
// (like the Google Contacts first-name-only bug this shipped alongside)
// can be cleanly undone and re-imported once fixed, rather than living
// with hundreds of wrong contacts or hand-deleting them one at a time.
app.delete('/api/contacts/import/batch/:id', async (c) => {
  const batchId = c.req.param('id');
  const { results: rows } = await c.env.DB.prepare('SELECT id FROM contacts WHERE import_batch_id = ?').bind(batchId).all<{ id: string }>();
  const ids = (rows ?? []).map((r) => r.id);

  const ID_CHUNK = 50;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    stmts.push(c.env.DB.prepare(`DELETE FROM voter_records WHERE contact_id IN (${placeholders})`).bind(...chunk));
    stmts.push(c.env.DB.prepare(`DELETE FROM contact_notes WHERE contact_id IN (${placeholders})`).bind(...chunk));
    stmts.push(c.env.DB.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).bind(...chunk));
  }
  stmts.push(c.env.DB.prepare('DELETE FROM import_batches WHERE id = ?').bind(batchId));
  await c.env.DB.batch(stmts);
  return c.json({ deletedCount: ids.length });
});

// GET /api/contacts/voter-names/preview — how many standalone voter-roll
// contacts (source = 'voter_file') would have their display name changed
// by cleanVoterDisplayName, plus a few before/after examples, for a
// confirm-before-running dialog. Scoped to source = 'voter_file' only: a
// contact that started as (or got merged into) a personal contact keeps
// whatever name Mike or Google gave it — this never touches those.
app.get('/api/contacts/voter-names/preview', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name FROM contacts WHERE source = 'voter_file'").all<{ id: string; name: string }>();
  const rows = results ?? [];
  const changed = rows
    .map((r) => ({ id: r.id, before: r.name, after: cleanVoterDisplayName(r.name) }))
    .filter((r) => r.after && r.after !== r.before);
  return c.json({ totalVoterContacts: rows.length, changeCount: changed.length, sample: changed.slice(0, 5) });
});

// POST /api/contacts/voter-names/cleanup-chunk — the actual rename, run in
// bounded slices (client loops this, same shape as the import commit's
// chunking) rather than one request touching all ~12k voter contacts at
// once — that unbounded-single-request pattern is exactly the production
// bug the chunked import commit exists to avoid; no reason to reintroduce
// it here. Ordered by id (stable across calls, unlike ordering by name —
// which this endpoint is busy changing).
//
// Paged by keyset (id > afterId), not OFFSET: D1 bills by rows *read*, and
// OFFSET makes SQLite walk past every already-seen row on every call — the
// last chunk of a 12k-row scan re-reads the same ~12k rows just to skip
// them, so the whole scan costs O(n^2) rows read instead of O(n). That's
// what actually tripped Cloudflare's free-tier daily row-read cap running
// the sibling voter-fields backfill below. Keyset pagination reads only
// the rows in the current page, every time, and is also safe against rows
// changing mid-scan (which OFFSET isn't).
app.post('/api/contacts/voter-names/cleanup-chunk', async (c) => {
  const body = await c.req.json<{ afterId?: string | null; limit: number }>();
  const afterId = body.afterId ?? null;
  const limit = Math.min(body.limit ?? 200, 500);

  const { results } = await (afterId
    ? c.env.DB.prepare("SELECT id, name FROM contacts WHERE source = 'voter_file' AND id > ? ORDER BY id LIMIT ?").bind(afterId, limit)
    : c.env.DB.prepare("SELECT id, name FROM contacts WHERE source = 'voter_file' ORDER BY id LIMIT ?").bind(limit)
  ).all<{ id: string; name: string }>();
  const rows = results ?? [];

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  for (const r of rows) {
    const cleaned = cleanVoterDisplayName(r.name);
    if (cleaned && cleaned !== r.name) {
      stmts.push(c.env.DB.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').bind(cleaned, ts, r.id));
      updated++;
    }
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return c.json({ processed: rows.length, updated, nextCursor, done: rows.length < limit });
});

// POST /api/contacts/voter-fields/backfill-chunk — re-parses every already-
// imported voter_records row's still-intact raw_data with extractVoterFields
// (the corrected column mapping — see 0022_voter_record_fields.sql) and
// fills in the new columns, without requiring Mike to re-import the whole
// file. Also additively backfills the linked contact's birthday/address if
// they're still blank, same "only fill in what's missing, never overwrite"
// rule the rest of this file's merge logic follows. Chunked for the same
// reason voter-names/cleanup-chunk above is — this can be thousands of
// rows, and one unbounded request is exactly the pattern that already
// caused a production failure once (see processDecisionChunk's comment).
//
// Paged by keyset (id > afterId), not OFFSET — see the comment on
// voter-names/cleanup-chunk above for why: this endpoint's own first
// production run, paged by OFFSET across ~280 chunk calls over 12,109
// rows, is what actually tripped Cloudflare's free-tier daily D1 row-read
// cap (each call re-scanned every row already seen, so total rows read
// grew roughly with n^2, not n).
app.post('/api/contacts/voter-fields/backfill-chunk', async (c) => {
  const body = await c.req.json<{ afterId?: string | null; limit: number }>();
  const afterId = body.afterId ?? null;
  const limit = Math.min(body.limit ?? 200, 500);

  const { results } = await (afterId
    ? c.env.DB.prepare('SELECT id, contact_id, raw_data FROM voter_records WHERE id > ? ORDER BY id LIMIT ?').bind(afterId, limit)
    : c.env.DB.prepare('SELECT id, contact_id, raw_data FROM voter_records ORDER BY id LIMIT ?').bind(limit)
  ).all<{ id: string; contact_id: string; raw_data: string }>();
  const rows = results ?? [];

  // One batched lookup for every contact this chunk touches, not a
  // per-row awaited SELECT inside the loop below — the exact sequential-
  // round-trip pattern that already took down a production request once
  // on this same voter file (see processDecisionChunk's comment above).
  // D1/SQLite caps bound parameters per statement, so a 200-item IN clause
  // in one query errors out ("too many SQL variables") — chunked into
  // batches of 50, same ID_CHUNK size the import-batch delete endpoint
  // above already uses for the same reason.
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const contactsById = new Map<string, { birthday_month: number | null; address: string | null }>();
  const CONTACT_ID_CHUNK = 50;
  for (let i = 0; i < contactIds.length; i += CONTACT_ID_CHUNK) {
    const idChunk = contactIds.slice(i, i + CONTACT_ID_CHUNK);
    const placeholders = idChunk.map(() => '?').join(', ');
    const { results: contactRows } = await c.env.DB.prepare(`SELECT id, birthday_month, address FROM contacts WHERE id IN (${placeholders})`)
      .bind(...idChunk)
      .all<{ id: string; birthday_month: number | null; address: string | null }>();
    for (const cr of contactRows ?? []) contactsById.set(cr.id, cr);
  }

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  for (const r of rows) {
    let raw: Record<string, string>;
    try {
      raw = JSON.parse(r.raw_data) as Record<string, string>;
    } catch {
      continue;
    }
    const f = extractVoterFields(raw);
    stmts.push(
      c.env.DB.prepare(
        `UPDATE voter_records SET
           gender = ?, registered_date = ?, phone = ?, polling_place = ?, causeway_tag = ?,
           calculated_party = ?, household_party = ?, household_code = ?, cd = ?, sd = ?, ad = ?, ld = ?,
           gop_matrix = ?, voting_history = ?, updated_at = ?
         WHERE id = ?`
      ).bind(
        f.gender, f.registered_date, f.voter_phone, f.polling_place, f.causeway_tag,
        f.calculated_party, f.household_party, f.household_code, f.cd, f.sd, f.ad, f.ld,
        f.gop_matrix, f.voting_history ? JSON.stringify(f.voting_history) : null, ts, r.id
      )
    );

    const contact = contactsById.get(r.contact_id);
    if (contact) {
      const contactFields: [string, unknown][] = [];
      if (!contact.birthday_month && f.birthday_month) {
        contactFields.push(['birthday_month', f.birthday_month], ['birthday_day', f.birthday_day], ['birthday_year', f.birthday_year]);
      }
      // Plain "fill in if blank" isn't enough for address: every voter
      // contact already has SOME address string (the original importer's
      // street-name-only "ADDRESS D/S/T/P" value, e.g. "COTTAGE TER"), so
      // it's never blank — it's just missing the house number that
      // extractVoterFields' corrected mapping now includes. Overwrite it
      // specifically when the stored value looks like that old bug (no
      // leading house number) and the freshly-extracted one has one.
      const hasHouseNumber = (addr: string | null) => !!addr && /^\d/.test(addr.trim());
      if (f.address && (!contact.address || (!hasHouseNumber(contact.address) && hasHouseNumber(f.address)))) {
        contactFields.push(['address', f.address]);
      }
      if (contactFields.length > 0) {
        contactFields.push(['updated_at', ts]);
        const setClause = contactFields.map(([k]) => `${k} = ?`).join(', ');
        stmts.push(
          c.env.DB.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`).bind(...contactFields.map(([, v]) => v), r.contact_id)
        );
      }
    }
    updated++;
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : afterId;
  return c.json({ processed: rows.length, updated, nextCursor, done: rows.length < limit });
});

// GET/DELETE /api/contacts/import/orphaned — cleanup for imports that
// died before this chunked flow existed (or, in principle, any future
// chunk that fails after commit/start but before commit/finish): a
// contact whose import_batch_id doesn't match any row in import_batches
// is debris from a run that never completed, not real data worth
// keeping. Scoped precisely to that condition, so it can never touch a
// contact from a normal completed import or a manually-created one
// (which has import_batch_id = NULL).
app.get('/api/contacts/import/orphaned', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, source, import_batch_id FROM contacts
     WHERE import_batch_id IS NOT NULL AND import_batch_id NOT IN (SELECT id FROM import_batches)
     LIMIT 5`
  ).all<{ id: string; name: string; source: string; import_batch_id: string }>();
  const { results: countRows } = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM contacts
     WHERE import_batch_id IS NOT NULL AND import_batch_id NOT IN (SELECT id FROM import_batches)`
  ).all<{ n: number }>();
  return c.json({ count: countRows?.[0]?.n ?? 0, sample: results ?? [] });
});

app.delete('/api/contacts/import/orphaned', async (c) => {
  const { results: orphanIds } = await c.env.DB.prepare(
    `SELECT id FROM contacts WHERE import_batch_id IS NOT NULL AND import_batch_id NOT IN (SELECT id FROM import_batches)`
  ).all<{ id: string }>();
  const ids = (orphanIds ?? []).map((r) => r.id);
  if (ids.length === 0) return c.json({ deletedCount: 0 });

  // D1 caps bound variables per statement well under SQLite's own 999 —
  // a real production import (192 orphaned rows, discovered fixing the
  // chunked-commit bug above) blew past it with "too many SQL variables"
  // on a single big IN (...) list. Chunk the ids and run every delete
  // statement, across all three tables, as one atomic db.batch() call —
  // established pattern already used for the chunked import commit itself.
  const ID_CHUNK = 50;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    stmts.push(c.env.DB.prepare(`DELETE FROM voter_records WHERE contact_id IN (${placeholders})`).bind(...chunk));
    stmts.push(c.env.DB.prepare(`DELETE FROM contact_notes WHERE contact_id IN (${placeholders})`).bind(...chunk));
    stmts.push(c.env.DB.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).bind(...chunk));
  }
  await c.env.DB.batch(stmts);
  return c.json({ deletedCount: ids.length });
});

// ---- Projects (top-level) ----

// GET /api/projects — list all top-level projects with a section breakdown.
// Excludes Lists (see migrations/0029_lists.sql) — a List is stored as this
// same type='project' shape with is_list set, but shown on its own separate
// Lists page/nav item, not mixed in here.
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 AND type = 'project' AND is_list = 0 ORDER BY pinned DESC, position ASC, created_at ASC`
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

// ---- Lists (top-level, flat checklists — see migrations/0029_lists.sql) ----
//
// A List is the same type='project' shape as a Project (so it gets the same
// entity machinery — GET/PATCH/DELETE /api/entities/:id, reorder, pin, and
// every list ITEM is just an ordinary type='task' child, which is what
// makes the task detail panel's description/due-date/subtasks/attachments
// apply to list items for free) with is_list set, so it's shown on its own
// page instead of mixed into Projects.

app.get('/api/lists', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE is_top_level = 1 AND type = 'project' AND is_list = 1 ORDER BY pinned DESC, position ASC, created_at ASC`
  ).all<Entity>();

  const withCounts = await Promise.all(
    (results ?? []).map(async (list) => {
      const counts = await listItemCounts(c.env.DB, list.id);
      return { ...list, open_count: counts?.open_count ?? 0, done_count: counts?.done_count ?? 0 };
    })
  );
  return c.json(withCounts);
});

// POST /api/lists — create a new List { title }
app.post('/api/lists', async (c) => {
  const body = await c.req.json<{ title: string }>();
  if (!body.title || !body.title.trim()) {
    return c.json({ error: 'title is required' }, 400);
  }
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, is_list, last_touched, created_at, updated_at)
     VALUES (?, 'project', ?, NULL, NULL, 1, 'active', 0, 1, ?, ?, ?)`
  )
    .bind(id, body.title.trim(), ts, ts, ts)
    .run();
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

// POST /api/lists/:id/items — bulk-create items from pasted/typed lines
// { titles: string[] }, one task per non-blank line, in the order given.
// The dedicated endpoint (rather than looping POST /api/entities client
// side) keeps a 10-line grocery paste to one round trip and one
// touchProjectAncestor call instead of ten.
app.post('/api/lists/:id/items', async (c) => {
  const id = c.req.param('id');
  const list = await c.env.DB.prepare("SELECT * FROM entities WHERE id = ? AND is_list = 1").bind(id).first<Entity>();
  if (!list) return c.json({ error: 'list not found' }, 404);

  const body = await c.req.json<{ titles: string[] }>();
  const titles = (body.titles ?? []).map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) return c.json({ error: 'titles is required' }, 400);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?').bind(id).first<{ m: number }>();
  const ts = now();
  const startPos = (maxPos?.m ?? -1) + 1;
  const rows = titles.map((title, i) => ({ id: uid(), title, position: startPos + i }));
  await c.env.DB.batch(
    rows.map((row) =>
      c.env.DB.prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at)
         VALUES (?, 'task', ?, NULL, ?, 0, 'open', ?, ?, ?, ?)`
      ).bind(row.id, row.title, id, row.position, ts, ts, ts)
    )
  );
  await touchProjectAncestor(c.env.DB, id);

  const { results } = await c.env.DB.prepare('SELECT * FROM entities WHERE id IN (' + rows.map(() => '?').join(',') + ')')
    .bind(...rows.map((r) => r.id))
    .all<Entity>();
  return c.json({ items: results ?? [] }, 201);
});

// Note: there's deliberately no reset/clear-completed pair of endpoints
// here. Checking a list item off deletes it client-side (see
// ListDetail.tsx's checkOffItem) rather than flipping status='done' and
// leaving it around — a list gets checked off and moved on from, so
// there's nothing left to "clear" later.

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
    Partial<Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned' | 'due_date' | 'due_time' | 'last_touched'>>
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
    // Clearing the due date entirely takes any due time down with it — a
    // time without a date it belongs to is meaningless, and would
    // otherwise silently reappear if a due date got set again later.
    if (!body.due_date && body.due_time === undefined) {
      fields.push('due_time = ?');
      values.push(null);
    }
  }
  if (body.due_time !== undefined) {
    fields.push('due_time = ?');
    values.push(body.due_time);
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

  // Log completion events for the stats rollups (see migrations/0011) —
  // this is the single place every "check a task off" in the app goes
  // through, whether it's the Today page, a project list, Week view, or
  // the task detail panel, so hooking it here covers all of them. Only
  // fires on an actual open->done transition, not a no-op PATCH that
  // happens to repeat the current status. Toggling back off within the
  // same short window (a misclick) removes the most recent log entry for
  // this task instead of leaving a phantom completion in the history.
  if (existing.type === 'task' && body.status !== undefined && body.status !== existing.status) {
    if (body.status === 'done') {
      await c.env.DB.prepare(
        `INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(uid(), id, body.title ?? existing.title, ts, localDateString(ts))
        .run();
    } else if (existing.status === 'done') {
      await c.env.DB.prepare(
        `DELETE FROM task_completions WHERE id = (SELECT id FROM task_completions WHERE entity_id = ? ORDER BY completed_at DESC LIMIT 1)`
      )
        .bind(id)
        .run();
    }
  }

  // Log a "pushed" event for the Journal (see migrations/0020_journal.sql)
  // whenever an already-due-dated task's due date moves to a different,
  // still non-null date — the only shape of due_date change that's really
  // a "push" rather than first-time scheduling (no date -> a date) or
  // clearing it (a date -> no date), neither of which this fires for.
  if (existing.type === 'task' && body.due_date !== undefined && existing.due_date && body.due_date && body.due_date !== existing.due_date) {
    await c.env.DB.prepare(
      `INSERT INTO journal_task_reschedules (id, entity_id, title, from_due_date, to_due_date, rescheduled_at, rescheduled_date) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(uid(), id, body.title ?? existing.title, existing.due_date, body.due_date, ts, localDateString(ts))
      .run();
  }

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

// DELETE /api/entities/:id — recursively deletes descendants too (explicit
// walk rather than relying on FK cascade, since SQLite/D1 only enforces
// ON DELETE CASCADE when foreign_keys is pragma'd on for the connection)
app.delete('/api/entities/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT parent_id FROM entities WHERE id = ?').bind(id).first<{ parent_id: string | null }>();
  await deleteEntityDeep(c.env.DB, c.env.FILES, id);
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

// POST /api/tasks/reorder-day — { date: 'YYYY-MM-DD', ordered_ids: string[] }
// Promote/demote on the Day view: sets due_position (see
// migrations/0010_due_position.sql) for whichever of the given ids are
// actually due on `date`, in the given order. Deliberately its own
// endpoint rather than reusing POST /api/entities/reorder — that one scopes
// by parent_id (ordering within a single project), while the Day view's
// task list mixes tasks pulled from many different projects (and
// standalone ones) that share a due_date but not a parent, so parent_id
// scoping wouldn't touch most of them. The `AND due_date = ?` guard means a
// task that got rescheduled out from under a stale ordered_ids list (a
// slow client, a race) just gets silently skipped rather than mis-ordered.
app.post('/api/tasks/reorder-day', async (c) => {
  const body = await c.req.json<{ date: string; ordered_ids: string[] }>();
  if (!body.date) return c.json({ error: 'date is required (YYYY-MM-DD)' }, 400);
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);

  const stmts = body.ordered_ids.map((entityId, index) =>
    c.env.DB.prepare(`UPDATE entities SET due_position = ? WHERE id = ? AND due_date = ?`).bind(index, entityId, body.date)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ---- Recurring task definitions (Settings screen) ----
//
// A definition just describes a repeating chore ("mow lawn", every Monday);
// the actual task instances that show up on Today/Week/Month are ordinary
// entities spawned lazily by spawnDueRecurringTasks (see /api/today) — this
// CRUD surface only manages the definitions themselves. Deleting a
// definition never deletes any task it already spawned.

interface RecurringWithProject extends RecurringTaskDefinition {
  project_title: string | null;
}

// GET /api/recurring — every definition (active and inactive), newest
// first, with its project's title resolved for display (NULL for a
// standalone recurring task).
app.get('/api/recurring', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, p.title as project_title
     FROM recurring_task_definitions r
     LEFT JOIN entities p ON p.id = r.project_id
     ORDER BY r.created_at DESC`
  ).all<RecurringWithProject>();
  return c.json(results ?? []);
});

// POST /api/recurring — create a new definition. `rrule` must be a bare
// RFC5545 RRULE string (no "RRULE:" prefix, no DTSTART line — that comes
// from `dtstart` separately so it can double as the "first occurrence"
// date shown/edited on its own in the form).
app.post('/api/recurring', async (c) => {
  const body = await c.req.json<{
    title: string;
    project_id?: string | null;
    rrule: string;
    dtstart: string;
    active?: boolean;
  }>();

  const title = body.title?.trim();
  if (!title) return c.json({ error: 'title is required' }, 400);
  if (!body.rrule?.trim()) return c.json({ error: 'rrule is required' }, 400);
  if (!body.dtstart) return c.json({ error: 'dtstart is required (YYYY-MM-DD)' }, 400);
  if (!isValidRrule(body.rrule.trim())) return c.json({ error: 'rrule does not parse as a valid RFC5545 rule' }, 400);

  if (body.project_id) {
    const project = await c.env.DB.prepare('SELECT id FROM entities WHERE id = ?').bind(body.project_id).first();
    if (!project) return c.json({ error: 'project not found' }, 404);
  }

  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  )
    .bind(id, title, body.project_id ?? null, body.rrule.trim(), body.dtstart, body.active === false ? 0 : 1, ts, ts)
    .run();

  const def = await c.env.DB.prepare('SELECT * FROM recurring_task_definitions WHERE id = ?').bind(id).first();
  return c.json(def, 201);
});

// PATCH /api/recurring/:id — edit any subset of fields. Changing `rrule` or
// `dtstart` does not retroactively touch the already-spawned current task;
// it only changes what spawns next.
app.patch('/api/recurring/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<{
    title: string;
    project_id: string | null;
    rrule: string;
    dtstart: string;
    active: boolean;
  }>>();

  const existing = await c.env.DB.prepare('SELECT * FROM recurring_task_definitions WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.rrule !== undefined && !isValidRrule(body.rrule.trim())) {
    return c.json({ error: 'rrule does not parse as a valid RFC5545 rule' }, 400);
  }
  if (body.project_id) {
    const project = await c.env.DB.prepare('SELECT id FROM entities WHERE id = ?').bind(body.project_id).first();
    if (!project) return c.json({ error: 'project not found' }, 404);
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) { fields.push('title = ?'); values.push(body.title.trim()); }
  if (body.project_id !== undefined) { fields.push('project_id = ?'); values.push(body.project_id); }
  if (body.rrule !== undefined) { fields.push('rrule = ?'); values.push(body.rrule.trim()); }
  if (body.dtstart !== undefined) { fields.push('dtstart = ?'); values.push(body.dtstart); }
  if (body.active !== undefined) { fields.push('active = ?'); values.push(body.active ? 1 : 0); }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(now());
    values.push(id);
    await c.env.DB.prepare(`UPDATE recurring_task_definitions SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const def = await c.env.DB.prepare('SELECT * FROM recurring_task_definitions WHERE id = ?').bind(id).first();
  return c.json(def);
});

// DELETE /api/recurring/:id — removes the definition only; any task it has
// already spawned (including the current outstanding one) stays exactly as
// it is on the planner.
app.delete('/api/recurring/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM recurring_task_definitions WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM recurring_task_definitions WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// GET /api/recurring/preview?rrule=&dtstart= — human-readable summary of an
// RRULE string (e.g. "every week on Monday") for the live preview in the
// Settings form, so Mike can sanity-check what he typed before saving.
app.get('/api/recurring/preview', async (c) => {
  const rrule = c.req.query('rrule');
  const dtstart = c.req.query('dtstart');
  if (!rrule || !dtstart) return c.json({ error: 'rrule and dtstart query params are required' }, 400);
  try {
    return c.json({ text: describeRrule(rrule, dtstart) });
  } catch {
    return c.json({ error: "rrule does not parse — check the syntax (e.g. FREQ=WEEKLY;BYDAY=MO)" }, 400);
  }
});

// Number of whole days since the Unix epoch for a YYYY-MM-DD date — used
// only as a stable, ever-incrementing rotation index (see computeSpotlight
// below), not for any calendar-math correctness concern.
function daysSinceEpoch(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

// Used by /api/today: the Day view's "Worth Revisiting" nudge. Originally
// surfaced the stalest untouched note/jot, but Mike found that pointless —
// the same single item (whichever was already oldest) just sat there
// forever, since opening a note from here doesn't count as "touching" it.
// Replaced with something actionable: one open, unscheduled task (no due
// date at all — the same backlog Week view's "Unscheduled" shelf already
// lists) per day, so seeing it in the daily planner is a nudge to either
// do it or actually give it a due date. Deterministic on `date` (not
// random) so it's stable across reloads/tab-switches within the same day,
// and rotates through the whole backlog in the shelf's own oldest-first
// order — one different task highlighted each calendar day — rather than
// picking the same one repeatedly. Browsing to a different day via the
// prev/next arrows shows what that day's pick would be, same as Overdue
// already varies with the viewed date.
async function computeSpotlight(db: D1Database, date: string): Promise<Entity | null> {
  const { results } = await db
    .prepare(`SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NULL ORDER BY COALESCE(last_touched, updated_at) ASC`)
    .all<Entity>();
  if (!results || results.length === 0) return null;
  const index = ((daysSinceEpoch(date) % results.length) + results.length) % results.length;
  return results[index];
}

// GET /api/today?date=YYYY-MM-DD&today=YYYY-MM-DD — every open task due on
// or before `date`, across every project plus standalone tasks, split into
// Overdue and the viewed day itself — the core query the daily planner view
// is built on. `date` is the day being VIEWED; the optional `today` is the
// viewer's own real local "today", same idea as /api/week's `today` param.
// They diverge when Mike uses the next/previous-day arrows to preview a
// date other than the actual current one — a task due tomorrow shouldn't
// read as "Overdue" just because he clicked forward to preview tomorrow's
// page before it's actually arrived. Overdue is therefore judged against
// whichever of `date`/`today` is earlier: viewing the past still shows the
// historical "what was outstanding as of that day" snapshot (using `date`,
// since real-today is later still), while viewing the future is judged
// against real-today instead (nothing is overdue before it actually
// happens, no matter how far forward you're peeking). `today` is optional
// and falls back to `date` when omitted, matching the old behavior for any
// caller that doesn't pass it. Also carries the "Worth Revisiting" daily
// spotlight — see computeSpotlight.
app.get('/api/today', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);
  const realToday = c.req.query('today') || date;
  const overdueAsOf = realToday < date ? realToday : date;

  // Materialize any recurring tasks due as of whichever is later, the
  // viewer's real "today" or the day being previewed — a definition only
  // ever has one live instance at a time (see spawnDueRecurringTasks), so
  // previewing forward just surfaces that same next occurrence early
  // rather than spawning a pile of future ones; browsing back to today
  // afterward finds it already there instead of doubly spawning.
  await spawnDueRecurringTasks(c.env.DB, maxIso(date, realToday));

  // overdueAsOf is always <= date (it's the earlier of the two), so a
  // single due_date <= date bound covers both buckets below.
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date ASC, due_position IS NULL, due_position ASC, position ASC`
  )
    .bind(date)
    .all<Entity>();

  const resolveProject = makeProjectResolver(c.env.DB);
  const withProject = await Promise.all(
    (results ?? []).map(async (task) => ({ ...task, project: await resolveProject(task.parent_id) }))
  );

  const recurringIds = await recurringCurrentTaskIds(c.env.DB);
  const overdue = tagRecurring(withProject.filter((t) => t.due_date! < overdueAsOf), recurringIds);
  // Recurring tasks float to the top of the day's own list — a stable sort
  // preserves each group's existing due_position order, so this composes
  // cleanly with promote/demote (which only ever swaps adjacent rows in
  // whatever order this endpoint returns).
  const today = tagRecurring(withProject.filter((t) => t.due_date === date), recurringIds).sort(
    (a, b) => Number(b.is_recurring) - Number(a.is_recurring)
  );
  const spotlightRaw = await computeSpotlight(c.env.DB, date);
  const spotlight = spotlightRaw ? { ...spotlightRaw, project: await resolveProject(spotlightRaw.parent_id) } : null;

  // Birthdays & Anniversaries for the viewed day — month/day match only
  // (year is optional/nullable and irrelevant to "does this fall on this
  // day"), per idx_contacts_birthday's own stated purpose (see
  // 0017_contacts.sql). Today page's "Important Dates" panel had this as a
  // hardcoded placeholder from before Contacts existed; this is what
  // actually wires it up. Anniversary has no matching index (this table
  // predates it having one), but the contacts table is small enough that a
  // full scan here is fine — same trade Contacts search already makes
  // elsewhere in this file.
  //
  // Deliberately NOT filtering out source = 'voter_file' the way
  // GET /api/contacts does by default — a voter-roll row with a real DOB is
  // still a real birthday, and Mike asked for these to be visibly labeled
  // by source rather than silently dropped. `source` rides along so the
  // client can show the same 🗳️ marker ContactsListPage already uses for
  // "this came from the voter roll, not a contact I added myself".
  const [dm, dd] = date.split('-').slice(1).map(Number);
  const { results: birthdayContacts } = await c.env.DB.prepare(
    `SELECT id, name, birthday_year, source FROM contacts WHERE birthday_month = ? AND birthday_day = ? ORDER BY name ASC`
  )
    .bind(dm, dd)
    .all<{ id: string; name: string; birthday_year: number | null; source: string }>();
  const { results: anniversaryContacts } = await c.env.DB.prepare(
    `SELECT id, name, anniversary_year, source FROM contacts WHERE anniversary_month = ? AND anniversary_day = ? ORDER BY name ASC`
  )
    .bind(dm, dd)
    .all<{ id: string; name: string; anniversary_year: number | null; source: string }>();

  // Tasks actually checked off on the viewed day (task_completions'
  // completed_date, not due_date — a task finished a day late should still
  // show up under the day it was really done). Included for today itself
  // too now — Mike wants a checked-off task to stay visible (struck
  // through, at the bottom of the list) rather than just vanish, on any
  // day, not only past ones.
  let completed: { id: string; entity_id: string; title: string; completed_at: string; completed_date: string }[] = [];
  if (date <= realToday) {
    const { results: completions } = await c.env.DB.prepare(
      `SELECT * FROM task_completions WHERE completed_date = ? ORDER BY completed_at ASC`
    )
      .bind(date)
      .all<{ id: string; entity_id: string; title: string; completed_at: string; completed_date: string }>();
    completed = completions ?? [];
  }

  return c.json({
    date,
    overdue,
    today,
    spotlight,
    birthdays: birthdayContacts ?? [],
    anniversaries: anniversaryContacts ?? [],
    completed,
  });
});

// GET /api/week?start=YYYY-MM-DD&today=YYYY-MM-DD — a 7-day docket starting
// on `start` (a Monday, matching a physical weekly planner), one bucket per
// day of exactly what's due that day, plus an `unscheduled` shelf of every
// open task with no due date at all (draggable onto a day by the client).
// Overdue is deliberately NOT repeated on every column — it only means
// anything relative to the real current day, so it's attached only to
// whichever day matches `today` (when that day falls inside the visible
// week at all; looking at a past or future week shows none, same as a
// paper planner's other weeks never show today's leftovers). `unscheduled`,
// by contrast, isn't day-relative, so it's always returned regardless of
// which week is being viewed. The "Worth Revisiting" daily spotlight shows
// only on the Day view — see computeSpotlight and /api/today.
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

  // Materialize any recurring tasks due anywhere in the visible week (or by
  // the viewer's real "today", if that falls later than the week shown) —
  // without this, a recurring definition only ever produces a real task
  // once the Day view has been opened for its due date, so Week view could
  // go on showing nothing for it indefinitely. See the same reasoning on
  // /api/today.
  await spawnDueRecurringTasks(c.env.DB, today ? maxIso(end, today) : end);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date ASC, due_position IS NULL, due_position ASC, position ASC`
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

  // Completed-task log for the visible week, bucketed by the day they were
  // actually checked off (completed_date) rather than by due_date — so a
  // task finished a day late still shows up under the day it was really
  // done. Only surfaced for days strictly before the viewer's real `today`:
  // Mike asked to see "progress I've made previously" on past days, and
  // today's own column already has its own completed-task story (the
  // checkbox just disappears there, with the Day view's "N Completed Today"
  // badge as the running count) — duplicating that here would be noise, not
  // a record. Skipped entirely when `today` wasn't supplied.
  let completedByDay = new Map<string, { id: string; entity_id: string; title: string; completed_at: string; completed_date: string }[]>();
  if (today) {
    const { results: completions } = await c.env.DB.prepare(
      `SELECT * FROM task_completions WHERE completed_date >= ? AND completed_date <= ? AND completed_date < ? ORDER BY completed_at ASC`
    )
      .bind(start, end, today)
      .all<{ id: string; entity_id: string; title: string; completed_at: string; completed_date: string }>();
    completedByDay = new Map();
    for (const row of completions ?? []) {
      const list = completedByDay.get(row.completed_date);
      if (list) list.push(row);
      else completedByDay.set(row.completed_date, [row]);
    }
  }

  const byDay = days.map((date) => ({
    date,
    isToday: date === todayInRange,
    tasks: withProject.filter((t) => t.due_date === date),
    completed: completedByDay.get(date) ?? [],
  }));

  return c.json({ start, end, days: byDay, overdue, unscheduled });
});

// GET /api/month?start=YYYY-MM-DD&end=YYYY-MM-DD — every open task due
// anywhere in [start, end], flat (not bucketed by day — the client groups
// them, same as it already computes the grid's padding days from the
// previous/next month). `start`/`end` are the full visible grid the client
// is rendering (the Sunday on/before the 1st through the Saturday on/after
// the last day), not just the calendar month itself, so a task due on one
// of those spillover days still shows up in its cell. No Overdue/Tickler/
// Unscheduled here — the Month view is a bird's-eye look at what's due
// when, not a place to work the backlog (that's what Day/Week are for).
app.get('/api/month', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (!start || !end) return c.json({ error: 'start and end query params are required (YYYY-MM-DD)' }, 400);

  // Same materialization as Day/Week — otherwise a recurring definition
  // never turns into a real task (and thus never counts toward a cell's "N
  // open tasks") until someone happens to open the Day view for that date
  // first. See /api/today.
  await spawnDueRecurringTasks(c.env.DB, end);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities WHERE type = 'task' AND status = 'open' AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date ASC, due_position IS NULL, due_position ASC, position ASC`
  )
    .bind(start, end)
    .all<Entity>();

  const resolveProject = makeProjectResolver(c.env.DB);
  const tasks = await Promise.all(
    (results ?? []).map(async (task) => ({ ...task, project: await resolveProject(task.parent_id) }))
  );

  return c.json({ start, end, tasks });
});

// Bedford Hills, NY 10507 — Mike's fixed home location for the Week/Day
// views' weather widget. Hardcoded rather than user-configurable for now;
// if that ever needs to change it's this one constant.
const WEATHER_LAT = 41.23667;
const WEATHER_LON = -73.69444;
const WEATHER_LOCATION_LABEL = 'Bedford Hills, NY';

// WMO weather codes (what Open-Meteo's `weathercode` field returns) reduced
// to one icon + one short label each — just enough to read at a glance in a
// small day-column chip. https://open-meteo.com/en/docs lists the full set;
// anything not named here (rare codes) falls back to a plain "—" so the UI
// never breaks on an unrecognized code.
const WEATHER_CODES: Record<number, { icon: string; summary: string }> = {
  0: { icon: '☀️', summary: 'Clear Sky' },
  1: { icon: '🌤️', summary: 'Mainly Clear' },
  2: { icon: '⛅', summary: 'Partly Cloudy' },
  3: { icon: '☁️', summary: 'Overcast' },
  45: { icon: '🌫️', summary: 'Fog' },
  48: { icon: '🌫️', summary: 'Depositing Rime Fog' },
  51: { icon: '🌦️', summary: 'Light Drizzle' },
  53: { icon: '🌦️', summary: 'Drizzle' },
  55: { icon: '🌦️', summary: 'Dense Drizzle' },
  56: { icon: '🌧️', summary: 'Freezing Drizzle' },
  57: { icon: '🌧️', summary: 'Freezing Drizzle' },
  61: { icon: '🌧️', summary: 'Light Rain' },
  63: { icon: '🌧️', summary: 'Rain' },
  65: { icon: '🌧️', summary: 'Heavy Rain' },
  66: { icon: '🌧️', summary: 'Freezing Rain' },
  67: { icon: '🌧️', summary: 'Freezing Rain' },
  71: { icon: '🌨️', summary: 'Light Snow' },
  73: { icon: '🌨️', summary: 'Snow' },
  75: { icon: '🌨️', summary: 'Heavy Snow' },
  77: { icon: '🌨️', summary: 'Snow Grains' },
  80: { icon: '🌦️', summary: 'Rain Showers' },
  81: { icon: '🌦️', summary: 'Rain Showers' },
  82: { icon: '🌧️', summary: 'Violent Rain Showers' },
  85: { icon: '🌨️', summary: 'Snow Showers' },
  86: { icon: '🌨️', summary: 'Heavy Snow Showers' },
  95: { icon: '⛈️', summary: 'Thunderstorm' },
  96: { icon: '⛈️', summary: 'Thunderstorm With Hail' },
  99: { icon: '⛈️', summary: 'Thunderstorm With Hail' },
};

// GET /api/weather — a ~16-day daily forecast for Mike's home location, via
// Open-Meteo (free, no API key). Proxied through the worker rather than
// called directly from the browser so the location lives in one place
// server-side, the shape returned to the client is already reduced to what
// the UI needs, and Cloudflare's edge cache (cf.cacheTtl below) means the
// upstream API isn't hit on every page load from every device.
app.get('/api/weather', async (c) => {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America%2FNew_York&forecast_days=16`;

  const upstream = await fetch(url, { cf: { cacheTtl: 1800, cacheEverything: true } });
  if (!upstream.ok) return c.json({ error: 'weather upstream failed' }, 502);
  const raw = await upstream.json<{
    daily: {
      time: string[];
      weathercode: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
      windspeed_10m_max: number[];
    };
  }>();

  const days = raw.daily.time.map((date, i) => {
    const code = raw.daily.weathercode[i];
    const known = WEATHER_CODES[code] ?? { icon: '—', summary: 'Unknown' };
    return {
      date,
      icon: known.icon,
      summary: known.summary,
      tempMaxF: Math.round(raw.daily.temperature_2m_max[i]),
      tempMinF: Math.round(raw.daily.temperature_2m_min[i]),
      precipProbability: Math.round(raw.daily.precipitation_probability_max[i]),
      windMaxMph: Math.round(raw.daily.windspeed_10m_max[i]),
    };
  });

  return c.json({ location: WEATHER_LOCATION_LABEL, days });
});

// Shared by /api/meetings and /api/meetings/range — fetches every active
// calendar_feeds row's ICS text at the edge (short cache, see the comment
// below) and reduces it to the {ics, calendar, calendarId} shape ics.ts's
// meetingsForRange/meetingsForDate expect. A feed whose URL doesn't parse
// as a calendar id, or whose fetch fails outright, is just dropped rather
// than surfaced as an error here — /api/calendars is where a broken feed's
// actual error message shows up for Mike to see.
// A short in-isolate cache of each feed's raw ICS text, on top of the
// `cf: { cacheTtl }` edge cache below — a Cloudflare Workers isolate is
// commonly reused across many requests in a row (Mike loading Today, then
// Journal, then Week, all within a few seconds), and each of those was
// separately paying a real fetch() round trip to Cloudflare's own cache
// even on a hit, plus every /api/meetings* call re-parses+RRULE-expands
// the ICS text regardless of the fetch itself. Caching the text here skips
// that redundant round trip entirely on a warm isolate. Kept well under
// the edge cache's own 300s TTL so this can never serve something staler
// than the edge cache would have anyway; cleared automatically on isolate
// recycle, so there's no explicit invalidation to worry about when Mike
// edits calendar feeds in Settings — worst case is up to 2 minutes behind.
const feedTextCache = new Map<string, { ics: string; fetchedAt: number }>();
const FEED_TEXT_CACHE_TTL_MS = 120_000;

async function fetchFeedSources(db: D1Database): Promise<{ ics: string; calendar: string; calendarId: string }[]> {
  const { results } = await db.prepare(`SELECT * FROM calendar_feeds WHERE active = 1`).all<CalendarFeedRow>();
  return (
    await Promise.all(
      (results ?? []).map(async (feed) => {
        const calendarId = calendarIdFromIcsUrl(feed.url);
        if (!calendarId) return null;

        const cached = feedTextCache.get(feed.url);
        if (cached && Date.now() - cached.fetchedAt < FEED_TEXT_CACHE_TTL_MS) {
          return { ics: cached.ics, calendar: feed.id, calendarId };
        }

        try {
          const upstream = await fetch(feed.url, { cf: { cacheTtl: 300, cacheEverything: true } });
          if (!upstream.ok) return null;
          const ics = await upstream.text();
          feedTextCache.set(feed.url, { ics, fetchedAt: Date.now() });
          return { ics, calendar: feed.id, calendarId };
        } catch {
          return null;
        }
      })
    )
  ).filter((s): s is { ics: string; calendar: string; calendarId: string } => s !== null);
}

// GET /api/meetings?date=YYYY-MM-DD — Mike's real Google Calendar events
// (not MikeOS tasks) due that day, pulled from the two calendars' secret
// ICS "basic.ics" addresses (GOOGLE_ICS_URL_PERSONAL / _SHARED — Worker
// secrets, see worker/src/types.ts and the deploy workflow's "Set Google
// Calendar ICS secrets" step). Deliberately read-only and lightweight:
// this is the ICS-URL approach Mike chose over full OAuth2, which means
// events are only as fresh as Google's own feed refresh (occasionally a
// few hours behind a last-minute change) and there's no create/RSVP path
// — acceptable for "what's on my calendar today", not attempted for
// anything write-side. Each feed is fetched at the edge with a short
// cache (5 min — meetings change more often than a weather forecast, so
// this is much shorter than /api/weather's) rather than on every request.
// Feeds come from the calendar_feeds table (see GET/POST/PATCH/DELETE
// /api/calendars below) — a feed with no rows, or every row inactive, just
// means no meetings, not an error.
// Tags each meeting with whether it already has a saved note (see
// migrations/0023_meeting_notes.sql) — one batched lookup rather than a
// per-meeting request, same "batch don't loop" rule the rest of this file
// follows (see the voter-fields backfill endpoint's own comment on why).
// Chunked at 50 ids per IN clause for the same D1 bound-parameter reason
// as everywhere else in this file that does this.
const NOTE_ID_CHUNK = 50;
async function tagHasNote<T extends { id: string }>(db: D1Database, meetings: T[]): Promise<(T & { hasNote: boolean })[]> {
  if (meetings.length === 0) return [];
  const ids = [...new Set(meetings.map((m) => m.id))];
  const withNotes = new Set<string>();
  for (let i = 0; i < ids.length; i += NOTE_ID_CHUNK) {
    const chunk = ids.slice(i, i + NOTE_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    // Joined against entities so a meeting whose linked note was since
    // deleted (from the Notes page itself, which knows nothing about this
    // linkage table) correctly reads back as "no note" instead of a
    // hasNote flag pointing at a dead id.
    const { results } = await db
      .prepare(
        `SELECT mn.meeting_id FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id WHERE mn.meeting_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<{ meeting_id: string }>();
    for (const r of results ?? []) withNotes.add(r.meeting_id);
  }
  return meetings.map((m) => ({ ...m, hasNote: withNotes.has(m.id) }));
}

app.get('/api/meetings', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);

  const sources = await fetchFeedSources(c.env.DB);
  const meetings = await tagHasNote(c.env.DB, meetingsForDate(sources, date));
  return c.json({ date, meetings });
});

// GET /api/meetings/range?start=YYYY-MM-DD&end=YYYY-MM-DD — the same real
// Google Calendar events as /api/meetings, but for the whole visible span
// of a Week or Month view in one call instead of one request per day; each
// meeting comes back tagged with its own local `date` so the caller can
// bucket occurrences by day the same way /api/month already buckets tasks
// by due_date.
app.get('/api/meetings/range', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (!start || !end) return c.json({ error: 'start and end query params are required (YYYY-MM-DD)' }, 400);

  const sources = await fetchFeedSources(c.env.DB);
  const meetings = await tagHasNote(c.env.DB, meetingsForRange(sources, start, end));
  return c.json({ start, end, meetings });
});

// ---- Meeting notes (one quick, sticky note per calendar-event occurrence) ----
//
// Meetings themselves are never stored in D1 (see fetchFeedSources/ics.ts —
// every /api/meetings* request re-parses the live ICS feed), so meetingId
// here is whatever MeetingItem.id already is: the ICS UID, or
// "<uid>:<occurrence start ISO>" for one occurrence of a recurring event.
// That's stable across requests (it's derived from the feed's own data,
// not assigned by us), so it works as a durable key even though the
// meeting it points at is never itself persisted.

// Returns the real note entity linked to this meeting, if any — self-heals
// a dangling link (note deleted from the Notes page itself, which knows
// nothing about meeting_notes) by dropping the stale row rather than
// reporting a noteEntityId that 404s when opened.
app.get('/api/meetings/:meetingId/note', async (c) => {
  const meetingId = c.req.param('meetingId');
  const row = await c.env.DB.prepare('SELECT id, note_entity_id FROM meeting_notes WHERE meeting_id = ?')
    .bind(meetingId)
    .first<{ id: string; note_entity_id: string | null }>();
  if (!row?.note_entity_id) return c.json({ noteEntityId: null });
  const entity = await c.env.DB.prepare('SELECT id FROM entities WHERE id = ?').bind(row.note_entity_id).first<{ id: string }>();
  if (!entity) {
    await c.env.DB.prepare('DELETE FROM meeting_notes WHERE id = ?').bind(row.id).run();
    return c.json({ noteEntityId: null });
  }
  return c.json({ noteEntityId: row.note_entity_id });
});

// POST — creates a real note entity (standalone, top-level, shown in the
// Notes section) and links it to this meeting, so the note icon opens
// something Mike can actually write in — attachments, the real editor,
// findable later from Notes — rather than a small popup. Idempotent: if
// this meeting already has a linked note, just returns it instead of
// creating a second one. Nothing is created just from viewing/opening a
// meeting — only when this endpoint is actually called (the note icon
// being clicked), matching the "only sticks to the meeting if a note was
// actually taken" rule 0023 set out, now expressed as "only created if the
// note icon was clicked" instead of "only saved once text was typed".
app.post('/api/meetings/:meetingId/note', async (c) => {
  const meetingId = c.req.param('meetingId');
  const body = await c.req.json<{ title: string }>();

  const existing = await c.env.DB.prepare('SELECT id, note_entity_id FROM meeting_notes WHERE meeting_id = ?')
    .bind(meetingId)
    .first<{ id: string; note_entity_id: string | null }>();
  if (existing?.note_entity_id) {
    const entity = await c.env.DB.prepare('SELECT id FROM entities WHERE id = ?').bind(existing.note_entity_id).first<{ id: string }>();
    if (entity) return c.json({ noteEntityId: existing.note_entity_id });
  }

  const noteId = uid();
  const ts = now();
  const title = body.title?.trim() || 'Untitled Note';
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
     VALUES (?, 'note', ?, NULL, NULL, 1, NULL, 0, ?, ?, ?, ?)`
  )
    .bind(noteId, title, ts, ts, ts, null)
    .run();

  if (existing) {
    await c.env.DB.prepare('UPDATE meeting_notes SET note_entity_id = ?, text = ?, updated_at = ? WHERE id = ?')
      .bind(noteId, '', ts, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO meeting_notes (id, meeting_id, note_entity_id, text, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)`
    )
      .bind(uid(), meetingId, noteId, ts, ts)
      .run();
  }
  return c.json({ noteEntityId: noteId }, 201);
});

// Unlinks (does not delete) the note entity — the entity itself is a
// regular note from here on and stays in Notes; this just removes the
// meeting -> note association, e.g. if Mike wants to re-link the icon to a
// different note. Not currently wired to any UI control, kept for
// completeness/future use.
app.delete('/api/meetings/:meetingId/note', async (c) => {
  const meetingId = c.req.param('meetingId');
  await c.env.DB.prepare('DELETE FROM meeting_notes WHERE meeting_id = ?').bind(meetingId).run();
  return c.json({ ok: true });
});

// ---- Calendar feeds (Settings screen's Calendar Integrations panel) ----
//
// Each row is one Google Calendar "secret address" (ICS) URL — self-service
// from Settings rather than a GitHub/Cloudflare secret, per Mike's own
// call: he'd rather add/edit/remove a calendar himself than go through a
// repo-secret-plus-redeploy cycle every time. The URL is still sensitive
// (equivalent to a password — anyone with it can read the whole calendar),
// so the list/detail responses below never echo it back in full; only
// POST/PATCH accept it, write-only from the client's perspective.

interface CalendarFeedRow {
  id: string;
  label: string;
  url: string;
  active: number;
  created_at: string;
  updated_at: string;
}

function maskUrl(url: string): string {
  if (url.length <= 12) return '••••••••';
  return `${url.slice(0, 8)}••••••••${url.slice(-8)}`;
}

// GET /api/calendars?today=YYYY-MM-DD — every feed with a live connection
// health check (fetched + parsed just now, not cached from an earlier
// call) so a broken feed shows exactly why, instead of /api/meetings'
// "any failure just means no meetings" behavior. `today` is optional —
// defaults to the server's own UTC date, which is only ever off by a few
// hours around midnight and doesn't matter for a connectivity check.
app.get('/api/calendars', async (c) => {
  const today = c.req.query('today') || now().slice(0, 10);
  const { results } = await c.env.DB.prepare(`SELECT * FROM calendar_feeds ORDER BY created_at ASC`).all<CalendarFeedRow>();

  const calendars = await Promise.all(
    (results ?? []).map(async (feed) => {
      const base = { id: feed.id, label: feed.label, urlPreview: maskUrl(feed.url), active: feed.active === 1 };
      if (feed.active !== 1) return { ...base, ok: false, error: null as string | null, eventCountToday: 0 };
      try {
        const upstream = await fetch(feed.url, { cf: { cacheTtl: 60, cacheEverything: true } });
        if (!upstream.ok) return { ...base, ok: false, error: `Feed returned HTTP ${upstream.status}`, eventCountToday: 0 };
        const ics = await upstream.text();
        const calendarId = calendarIdFromIcsUrl(feed.url) ?? '';
        const meetings = meetingsForDate([{ ics, calendar: feed.id, calendarId }], today);
        return { ...base, ok: true, error: null as string | null, eventCountToday: meetings.length };
      } catch (e) {
        return { ...base, ok: false, error: e instanceof Error ? e.message : String(e), eventCountToday: 0 };
      }
    })
  );

  return c.json({ today, calendars });
});

app.post('/api/calendars', async (c) => {
  const body = await c.req.json<{ label: string; url: string; active?: boolean }>();
  const label = body.label?.trim();
  const url = body.url?.trim();
  if (!label) return c.json({ error: 'label is required' }, 400);
  if (!url) return c.json({ error: 'url is required' }, 400);
  if (!calendarIdFromIcsUrl(url)) {
    return c.json({ error: "That doesn't look like a Google Calendar secret address (should contain /ical/.../basic.ics)" }, 400);
  }

  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO calendar_feeds (id, label, url, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, label, url, body.active === false ? 0 : 1, ts, ts)
    .run();

  return c.json({ id, label, urlPreview: maskUrl(url), active: body.active !== false }, 201);
});

app.patch('/api/calendars/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<{ label: string; url: string; active: boolean }>>();
  const existing = await c.env.DB.prepare('SELECT * FROM calendar_feeds WHERE id = ?').bind(id).first<CalendarFeedRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.url !== undefined && !calendarIdFromIcsUrl(body.url.trim())) {
    return c.json({ error: "That doesn't look like a Google Calendar secret address (should contain /ical/.../basic.ics)" }, 400);
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.label !== undefined) { fields.push('label = ?'); values.push(body.label.trim()); }
  if (body.url !== undefined) { fields.push('url = ?'); values.push(body.url.trim()); }
  if (body.active !== undefined) { fields.push('active = ?'); values.push(body.active ? 1 : 0); }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(now());
    values.push(id);
    await c.env.DB.prepare(`UPDATE calendar_feeds SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM calendar_feeds WHERE id = ?').bind(id).first<CalendarFeedRow>();
  return c.json({ id: updated!.id, label: updated!.label, urlPreview: maskUrl(updated!.url), active: updated!.active === 1 });
});

app.delete('/api/calendars/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM calendar_feeds WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM calendar_feeds WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---- Quick Links (sidebar "Links" tray, see migrations/0028_quick_links.sql) ----

interface QuickLinkRow {
  id: string;
  name: string;
  url: string;
  type: 'open' | 'copy';
  icon: string | null;
  thumbnail_key: string | null;
  category: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function quickLinkJson(row: QuickLinkRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    type: row.type,
    icon: row.icon,
    thumbnailUrl: row.thumbnail_key ? `/api/files/${row.thumbnail_key}` : null,
    category: row.category,
    sortOrder: row.sort_order,
  };
}

// GET /api/quick-links — ordered by sort_order, which also determines the
// category grouping order on the Links page (each category's tiles are
// wherever its members' sort_order values put them).
app.get('/api/quick-links', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM quick_links ORDER BY sort_order ASC, created_at ASC').all<QuickLinkRow>();
  return c.json({ links: (results ?? []).map(quickLinkJson) });
});

app.post('/api/quick-links', async (c) => {
  const body = await c.req.json<{
    name: string;
    url: string;
    type?: 'open' | 'copy';
    icon?: string | null;
    thumbnail_key?: string | null;
    category?: string;
  }>();
  const name = body.name?.trim();
  const url = body.url?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!url) return c.json({ error: 'url is required' }, 400);
  const type = body.type === 'copy' ? 'copy' : 'open';
  const category = body.category?.trim() || 'Links';

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM quick_links').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO quick_links (id, name, url, type, icon, thumbnail_key, category, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, url, type, body.icon ?? null, body.thumbnail_key ?? null, category, (maxPos?.m ?? -1) + 1, ts, ts)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM quick_links WHERE id = ?').bind(id).first<QuickLinkRow>();
  return c.json(quickLinkJson(row!), 201);
});

app.patch('/api/quick-links/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<{ name: string; url: string; type: 'open' | 'copy'; icon: string | null; thumbnail_key: string | null; category: string; sort_order: number }>
  >();
  const existing = await c.env.DB.prepare('SELECT * FROM quick_links WHERE id = ?').bind(id).first<QuickLinkRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name.trim()); }
  if (body.url !== undefined) { fields.push('url = ?'); values.push(body.url.trim()); }
  if (body.type !== undefined) { fields.push('type = ?'); values.push(body.type === 'copy' ? 'copy' : 'open'); }
  if (body.icon !== undefined) { fields.push('icon = ?'); values.push(body.icon); }
  if (body.thumbnail_key !== undefined) { fields.push('thumbnail_key = ?'); values.push(body.thumbnail_key); }
  if (body.category !== undefined) { fields.push('category = ?'); values.push(body.category.trim() || 'Links'); }
  if (body.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(body.sort_order); }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(now());
    values.push(id);
    await c.env.DB.prepare(`UPDATE quick_links SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM quick_links WHERE id = ?').bind(id).first<QuickLinkRow>();
  return c.json(quickLinkJson(updated!));
});

app.delete('/api/quick-links/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM quick_links WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM quick_links WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// GET /api/stats?date=YYYY-MM-DD — completed-task rollups for the Today
// widget and the Stats page, all anchored on the caller's local `date`
// (same convention as /api/today's `date`/`today` params) rather than the
// worker's own UTC clock. `week` follows the app's Monday-first
// convention (matching Week view); `month`/`year` are calendar buckets.
// `trend` is the last 14 local days (oldest first, zero-filled) for a
// simple sparkline/bar view — 14 is enough to see a pattern without
// turning the stats page into its own calendar.
function mondayOnOrBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = dow === 0 ? -6 : 1 - dow; // days back to Monday
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function addDaysStr(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

app.get('/api/stats', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);

  const weekStart = mondayOnOrBefore(date);
  const weekEnd = addDaysStr(weekStart, 6);
  const monthPrefix = date.slice(0, 7); // 'YYYY-MM'
  const yearPrefix = date.slice(0, 4); // 'YYYY'
  const trendStart = addDaysStr(date, -13);

  const [today, week, month, year, trendRows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date = ?`).bind(date).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date >= ? AND completed_date <= ?`)
      .bind(weekStart, weekEnd)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date LIKE ?`)
      .bind(`${monthPrefix}-%`)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date LIKE ?`)
      .bind(`${yearPrefix}-%`)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT completed_date, COUNT(*) as n FROM task_completions WHERE completed_date >= ? AND completed_date <= ? GROUP BY completed_date`
    )
      .bind(trendStart, date)
      .all<{ completed_date: string; n: number }>(),
  ]);

  const byDate = new Map((trendRows.results ?? []).map((r) => [r.completed_date, r.n]));
  const trend: { date: string; count: number }[] = [];
  for (let d = trendStart; d <= date; d = addDaysStr(d, 1)) {
    trend.push({ date: d, count: byDate.get(d) ?? 0 });
  }

  return c.json({
    date,
    today: today?.n ?? 0,
    week: week?.n ?? 0,
    month: month?.n ?? 0,
    year: year?.n ?? 0,
    trend,
  });
});

// GET /api/stats/completions?q=&limit=&before= — the actual completed-task
// log itself (not just counts), newest first, for the Stats page's "find
// when I did X" list. `q` filters by title substring (a plain LIKE is
// plenty at Mike's personal-app scale); `before` is a completed_at cursor
// for "load more" — pass the last row's completed_at back to page further
// into the past rather than re-fetching from the top. Reads from
// task_completions directly, same as /api/stats, so a task that's since
// been edited, moved, or deleted doesn't change what this shows: the
// title is the snapshot from the moment it was checked off (see
// migrations/0011_task_completions.sql).
app.get('/api/stats/completions', async (c) => {
  const q = c.req.query('q')?.trim();
  const before = c.req.query('before');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (q) {
    conditions.push('title LIKE ?');
    params.push(`%${q}%`);
  }
  if (before) {
    conditions.push('completed_at < ?');
    params.push(before);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch one extra row purely to know whether there's another page
  // without a separate COUNT(*) query.
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM task_completions ${where} ORDER BY completed_at DESC LIMIT ?`
  )
    .bind(...params, limit + 1)
    .all<{ id: string; entity_id: string; title: string; completed_at: string; completed_date: string }>();

  const rows = results ?? [];
  const hasMore = rows.length > limit;
  return c.json({ completions: rows.slice(0, limit), has_more: hasMore });
});

// ---- Canvas boards (infinite-canvas pinboard feature) ----
//
// A board is a lightweight container; the real content is its items (see
// migrations/0012_canvas_boards.sql for the schema and per-type `content`
// shapes). Image items reuse the existing R2-backed /api/upload endpoint
// (called with no parent_id, the same "inline attachment" mode a note's
// editor already uses) rather than a bespoke upload path here.

// GET /api/boards — pinned boards first (same convention as Projects'
// pinned-to-top), then most-recently-active (updated_at bumps on any item
// add/move/edit/delete, not just a title change — see touchBoard below),
// plus each board's own item_count for the list view's card (a plain
// COUNT rather than a stored counter, at this app's scale).
app.get('/api/boards', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM canvas_items i WHERE i.board_id = b.id) as item_count
     FROM canvas_boards b ORDER BY b.pinned DESC, b.updated_at DESC`
  ).all<CanvasBoard & { item_count: number }>();
  return c.json(results ?? []);
});

app.post('/api/boards', async (c) => {
  const body = await c.req.json<{ title?: string }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(`INSERT INTO canvas_boards (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(id, body.title?.trim() || 'Untitled Board', ts, ts)
    .run();
  const board = await c.env.DB.prepare('SELECT * FROM canvas_boards WHERE id = ?').bind(id).first<CanvasBoard>();
  return c.json(board, 201);
});

app.get('/api/boards/:id', async (c) => {
  const id = c.req.param('id');
  const board = await c.env.DB.prepare('SELECT * FROM canvas_boards WHERE id = ?').bind(id).first<CanvasBoard>();
  if (!board) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM canvas_items WHERE board_id = ? ORDER BY z_index ASC').bind(id).all<CanvasItem>();
  const { results: connectors } = await c.env.DB.prepare('SELECT * FROM canvas_connectors WHERE board_id = ?').bind(id).all<CanvasConnector>();
  return c.json({ board, items: results ?? [], connectors: connectors ?? [] });
});

app.patch('/api/boards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; pinned?: boolean }>();
  const existing = await c.env.DB.prepare('SELECT id FROM canvas_boards WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (body.title !== undefined) {
    await c.env.DB.prepare('UPDATE canvas_boards SET title = ?, updated_at = ? WHERE id = ?').bind(body.title.trim() || 'Untitled Board', now(), id).run();
  }
  if (body.pinned !== undefined) {
    // Bumps updated_at same as POST /api/entities/:id/pin does for
    // Projects — pinning/unpinning counts as touching the board.
    await c.env.DB.prepare('UPDATE canvas_boards SET pinned = ?, updated_at = ? WHERE id = ?').bind(body.pinned ? 1 : 0, now(), id).run();
  }
  const board = await c.env.DB.prepare('SELECT * FROM canvas_boards WHERE id = ?').bind(id).first<CanvasBoard>();
  return c.json(board);
});

// DELETE /api/boards/:id — removes the board and every item row on it.
// Image items' underlying R2 objects are deleted too (best-effort, same
// pattern as DELETE /api/entities/:id's file cleanup) so a deleted board
// doesn't leave orphaned uploads behind.
app.delete('/api/boards/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM canvas_boards WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const { results: items } = await c.env.DB.prepare(`SELECT * FROM canvas_items WHERE board_id = ? AND type = 'image'`).bind(id).all<CanvasItem>();
  await Promise.all(
    (items ?? []).map(async (item) => {
      try {
        const { r2_key } = JSON.parse(item.content) as { r2_key?: string };
        if (r2_key) await c.env.FILES.delete(r2_key);
      } catch {
        // malformed content JSON — nothing to clean up, not worth failing the whole delete over
      }
    })
  );

  await c.env.DB.prepare('DELETE FROM canvas_connectors WHERE board_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM canvas_items WHERE board_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM canvas_boards WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

async function touchBoard(db: D1Database, boardId: string) {
  await db.prepare('UPDATE canvas_boards SET updated_at = ? WHERE id = ?').bind(now(), boardId).run();
}

// POST /api/boards/:id/items — create one item at a given position. x/y/
// width/height are caller-supplied (the canvas computes them client-side
// from the drop point / default size) rather than derived server-side,
// since placement is inherently a UI concern here. z_index defaults to
// one past the board's current highest, so a freshly created item always
// starts on top.
app.post('/api/boards/:id/items', async (c) => {
  const boardId = c.req.param('id');
  const board = await c.env.DB.prepare('SELECT id FROM canvas_boards WHERE id = ?').bind(boardId).first();
  if (!board) return c.json({ error: 'board not found' }, 404);

  const body = await c.req.json<{
    type: CanvasItemType;
    x: number;
    y: number;
    width: number;
    height: number;
    content: Record<string, unknown>;
    title?: string | null;
  }>();
  if (!body.type || typeof body.x !== 'number' || typeof body.y !== 'number' || typeof body.width !== 'number' || typeof body.height !== 'number') {
    return c.json({ error: 'type, x, y, width, and height are required' }, 400);
  }

  const maxZ = await c.env.DB.prepare('SELECT COALESCE(MAX(z_index), -1) as m FROM canvas_items WHERE board_id = ?').bind(boardId).first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO canvas_items (id, board_id, type, x, y, width, height, z_index, content, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, boardId, body.type, body.x, body.y, body.width, body.height, (maxZ?.m ?? -1) + 1, JSON.stringify(body.content ?? {}), body.title?.trim() || null, ts, ts)
    .run();
  await touchBoard(c.env.DB, boardId);

  const item = await c.env.DB.prepare('SELECT * FROM canvas_items WHERE id = ?').bind(id).first<CanvasItem>();
  return c.json(item, 201);
});

// PATCH /api/items/:id — move (x/y), resize (width/height), restack
// (z_index — "bring to front" sends max(existing)+1, computed client-side
// from the board's already-loaded items), or edit (content, e.g. a text/
// note item's typed text). Only the fields present in the body are
// touched, same partial-update convention as PATCH /api/entities/:id.
app.patch('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM canvas_items WHERE id = ?').bind(id).first<CanvasItem>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json<Partial<{ x: number; y: number; width: number; height: number; z_index: number; content: Record<string, unknown>; title: string | null }>>();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of ['x', 'y', 'width', 'height', 'z_index'] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (body.content !== undefined) {
    fields.push('content = ?');
    values.push(JSON.stringify(body.content));
  }
  if (body.title !== undefined) {
    fields.push('title = ?');
    values.push(body.title?.trim() || null);
  }
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(now());
    await c.env.DB.prepare(`UPDATE canvas_items SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id).run();
    await touchBoard(c.env.DB, existing.board_id);
  }

  const item = await c.env.DB.prepare('SELECT * FROM canvas_items WHERE id = ?').bind(id).first<CanvasItem>();
  return c.json(item);
});

// DELETE /api/items/:id — also purges the R2 object for an image item,
// same reasoning as DELETE /api/boards/:id above.
app.delete('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM canvas_items WHERE id = ?').bind(id).first<CanvasItem>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (existing.type === 'image') {
    try {
      const { r2_key } = JSON.parse(existing.content) as { r2_key?: string };
      if (r2_key) await c.env.FILES.delete(r2_key);
    } catch {
      // malformed content JSON — nothing to clean up
    }
  }

  await c.env.DB.prepare('DELETE FROM canvas_connectors WHERE from_item_id = ? OR to_item_id = ?').bind(id, id).run();
  await c.env.DB.prepare('DELETE FROM canvas_items WHERE id = ?').bind(id).run();
  await touchBoard(c.env.DB, existing.board_id);
  return c.json({ ok: true });
});

// POST /api/boards/:id/connectors — link two items with an arrow. No
// anchor/side is stored (see migrations/0013_canvas_connectors.sql):
// the endpoints are recomputed from each item's current box every time
// the board renders, which is what makes the arrow follow a dragged card
// automatically. Self-links and exact duplicate connectors are rejected
// since neither makes sense to draw.
app.post('/api/boards/:id/connectors', async (c) => {
  const boardId = c.req.param('id');
  const board = await c.env.DB.prepare('SELECT id FROM canvas_boards WHERE id = ?').bind(boardId).first();
  if (!board) return c.json({ error: 'board not found' }, 404);

  const body = await c.req.json<{ from_item_id?: string; to_item_id?: string }>();
  if (!body.from_item_id || !body.to_item_id) return c.json({ error: 'from_item_id and to_item_id are required' }, 400);
  if (body.from_item_id === body.to_item_id) return c.json({ error: 'cannot connect an item to itself' }, 400);

  const [fromItem, toItem] = await Promise.all([
    c.env.DB.prepare('SELECT id FROM canvas_items WHERE id = ? AND board_id = ?').bind(body.from_item_id, boardId).first(),
    c.env.DB.prepare('SELECT id FROM canvas_items WHERE id = ? AND board_id = ?').bind(body.to_item_id, boardId).first(),
  ]);
  if (!fromItem || !toItem) return c.json({ error: 'from_item_id and to_item_id must both belong to this board' }, 400);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM canvas_connectors WHERE board_id = ?
       AND ((from_item_id = ? AND to_item_id = ?) OR (from_item_id = ? AND to_item_id = ?))`
  )
    .bind(boardId, body.from_item_id, body.to_item_id, body.to_item_id, body.from_item_id)
    .first<{ id: string }>();
  if (dup) return c.json({ error: 'already connected' }, 409);

  const id = uid();
  await c.env.DB.prepare('INSERT INTO canvas_connectors (id, board_id, from_item_id, to_item_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, boardId, body.from_item_id, body.to_item_id, now())
    .run();
  await touchBoard(c.env.DB, boardId);

  const connector = await c.env.DB.prepare('SELECT * FROM canvas_connectors WHERE id = ?').bind(id).first<CanvasConnector>();
  return c.json(connector, 201);
});

app.delete('/api/connectors/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM canvas_connectors WHERE id = ?').bind(id).first<CanvasConnector>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM canvas_connectors WHERE id = ?').bind(id).run();
  await touchBoard(c.env.DB, existing.board_id);
  return c.json({ ok: true });
});

// ---- Journal ----
//
// ---------------------------------------------------------------------
// Health dashboard — Google Health weekly-report import. See
// worker/src/health.ts for the parser itself and
// worker/migrations/0025_health_weekly_reports.sql for the schema/design
// rationale (self-computed deltas, per-metric null handling for weeks the
// tracker wasn't worn, upsert-by-week_start for safe re-uploads).
// ---------------------------------------------------------------------

function healthRowToPreviewWeek(p: ReturnType<typeof parseHealthWeek>) {
  return {
    week_start: p.weekStart,
    week_end: p.weekEnd,
    total_steps: p.totalSteps,
    avg_steps_per_day: p.avgStepsPerDay,
    best_day_steps: p.bestDaySteps,
    best_day_weekday: p.bestDayWeekday,
    total_floors: p.totalFloors,
    total_miles: p.totalMiles,
    avg_calories_burned: p.avgCaloriesBurned,
    avg_active_zone_minutes: p.avgActiveZoneMinutes,
    avg_restful_sleep_minutes: p.avgRestfulSleepMinutes,
    avg_hours_with_250_steps: p.avgHoursWith250Steps,
    avg_resting_heart_rate: p.avgRestingHeartRate,
    avg_weight_lb: p.avgWeightLb,
  };
}

// POST /api/health/parse — preview-only, no DB write. Body: { filename,
// text } where `text` is the client-extracted PDF text (see
// src/utils/pdfText.ts — grouped into lines the same way the parser
// expects, matching pdfplumber's own layout-aware extraction that the
// parser was validated against). Mirrors the contact-importer's
// preview-before-commit shape.
app.post('/api/health/parse', async (c) => {
  const body = await c.req.json<{ filename: string; text: string }>();
  if (!body.text) return c.json({ error: 'text required' }, 400);
  try {
    const parsed = parseHealthWeek(body.text);
    const existing = await c.env.DB.prepare('SELECT * FROM health_weekly_reports WHERE week_start = ?')
      .bind(parsed.weekStart)
      .first<HealthWeeklyReport>();
    return c.json({ filename: body.filename, week: healthRowToPreviewWeek(parsed), error: null, existing: existing ?? null });
  } catch (e) {
    const message = e instanceof HealthParseError ? e.message : 'Could not parse this file as a Google Health weekly report.';
    return c.json({ filename: body.filename, week: null, error: message, existing: null });
  }
});

// POST /api/health/import — commits one or more previewed weeks. Body:
// { imports: [{ filename, text }] }. Each is re-parsed server-side (never
// trusts a client-computed preview for the write) and upserted by
// week_start, so re-uploading an already-imported week — which Mike does
// on purpose, since his upload batches overlap — just overwrites that row
// with the same values rather than duplicating it.
app.post('/api/health/import', async (c) => {
  const body = await c.req.json<{ imports: { filename: string; text: string }[] }>();
  if (!body.imports?.length) return c.json({ error: 'no imports' }, 400);

  const batchId = uid();
  const ts = now();
  const weeks: string[] = [];
  const errors: { filename: string; error: string }[] = [];

  for (const item of body.imports) {
    try {
      const p = parseHealthWeek(item.text);
      await c.env.DB.prepare(
        `INSERT INTO health_weekly_reports (
           week_start, week_end, total_steps, avg_steps_per_day, best_day_steps, best_day_weekday,
           total_floors, total_miles, avg_calories_burned, avg_active_zone_minutes, avg_restful_sleep_minutes,
           avg_hours_with_250_steps, avg_resting_heart_rate, avg_weight_lb, raw_text, import_batch_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (week_start) DO UPDATE SET
           week_end = excluded.week_end,
           total_steps = excluded.total_steps,
           avg_steps_per_day = excluded.avg_steps_per_day,
           best_day_steps = excluded.best_day_steps,
           best_day_weekday = excluded.best_day_weekday,
           total_floors = excluded.total_floors,
           total_miles = excluded.total_miles,
           avg_calories_burned = excluded.avg_calories_burned,
           avg_active_zone_minutes = excluded.avg_active_zone_minutes,
           avg_restful_sleep_minutes = excluded.avg_restful_sleep_minutes,
           avg_hours_with_250_steps = excluded.avg_hours_with_250_steps,
           avg_resting_heart_rate = excluded.avg_resting_heart_rate,
           avg_weight_lb = excluded.avg_weight_lb,
           raw_text = excluded.raw_text,
           import_batch_id = excluded.import_batch_id,
           updated_at = excluded.updated_at`
      )
        .bind(
          p.weekStart,
          p.weekEnd,
          p.totalSteps,
          p.avgStepsPerDay,
          p.bestDaySteps,
          p.bestDayWeekday,
          p.totalFloors,
          p.totalMiles,
          p.avgCaloriesBurned,
          p.avgActiveZoneMinutes,
          p.avgRestfulSleepMinutes,
          p.avgHoursWith250Steps,
          p.avgRestingHeartRate,
          p.avgWeightLb,
          item.text,
          batchId,
          ts,
          ts
        )
        .run();
      weeks.push(p.weekStart);
    } catch (e) {
      const message = e instanceof HealthParseError ? e.message : 'Could not parse this file.';
      errors.push({ filename: item.filename, error: message });
    }
  }

  weeks.sort();
  return c.json({ imported: weeks.length, weeks, errors });
});

// GET /api/health/weekly — full history, oldest first, for the Health
// dashboard's trend charts and the Journal's per-day lookup below.
app.get('/api/health/weekly', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM health_weekly_reports ORDER BY week_start ASC').all<HealthWeeklyReport>();
  return c.json(results ?? []);
});

// A day's journal entry is mostly computed, not stored: journal_entries
// only holds the freeform text Mike adds himself (see
// migrations/0020_journal.sql for the full reasoning). Everything else
// shown on a day — calendar events, completed/pushed tasks, notes, contact
// quick-notes, habit values, health stats — is read live from the tables
// that already own it, so there's nothing here to keep in sync.
//
// A generous same-UTC-day-plus-neighbors window is fetched for created_at
// lookups (notes, contact notes) and then filtered precisely in
// application code with localDateString — the same helper task_completions
// already trusts — rather than duplicating timezone math in SQL. Personal
// data volumes here are small, so the extra rows fetched per call cost
// nothing.
// GET /api/journal/moods?start=&end= — just the {date, mood} pairs for a
// range, for the Journal page's mood trend strip. Deliberately not folded
// into the day-level GET /api/journal/:date (that's one day; this spans
// many) or into /api/stats (that endpoint's counts are all derived from
// task_completions, a different table entirely). Registered before
// /api/journal/:date below, same convention /api/contacts/duplicates
// follows ahead of /api/contacts/:id — a literal path segment should
// always be matched before a param route that could otherwise swallow it.
app.get('/api/journal/moods', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (!start || !end) return c.json({ error: 'start and end query params are required (YYYY-MM-DD)' }, 400);

  const { results } = await c.env.DB.prepare('SELECT date, mood FROM journal_entries WHERE date >= ? AND date <= ? AND mood IS NOT NULL ORDER BY date ASC')
    .bind(start, end)
    .all<{ date: string; mood: number }>();
  return c.json({ moods: results ?? [] });
});

app.get('/api/journal/:date', async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);

  // A window wide enough that any UTC-vs-local-day skew around `date`
  // still falls inside it, then narrowed exactly by localDateString below.
  const prevDate = localDateString(new Date(new Date(`${date}T12:00:00Z`).getTime() - 86400000).toISOString());
  const nextDate = localDateString(new Date(new Date(`${date}T12:00:00Z`).getTime() + 86400000).toISOString());
  const windowStart = `${prevDate}T00:00:00.000Z`;
  const windowEnd = `${nextDate}T23:59:59.999Z`;

  const entry = await c.env.DB.prepare('SELECT * FROM journal_entries WHERE date = ?').bind(date).first<JournalEntry>();

  const { results: completions } = await c.env.DB
    .prepare('SELECT * FROM task_completions WHERE completed_date = ? ORDER BY completed_at ASC')
    .bind(date)
    .all<{ id: string; entity_id: string; title: string; completed_at: string; completed_date: string }>();

  const { results: reschedules } = await c.env.DB
    .prepare('SELECT * FROM journal_task_reschedules WHERE rescheduled_date = ? ORDER BY rescheduled_at ASC')
    .bind(date)
    .all<TaskReschedule>();

  // is_top_level tells the frontend which route resolves a given note
  // correctly: a nested note (e.g. inside a project) only renders right at
  // /projects/:id (that page walks parent_id for the breadcrumb + content;
  // /notes/:id only ever looks at top-level notes) — see JournalPage's
  // note-link logic.
  const { results: noteRows } = await c.env.DB
    .prepare(
      `SELECT id, title, is_jot, is_top_level, created_at FROM entities WHERE type = 'note' AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC`
    )
    .bind(windowStart, windowEnd)
    .all<{ id: string; title: string; is_jot: number; is_top_level: number; created_at: string }>();
  const notes = (noteRows ?? []).filter((n) => localDateString(n.created_at) === date);

  const { results: contactNoteRows } = await c.env.DB
    .prepare(
      `SELECT cn.id, cn.contact_id, cn.text, cn.created_at, c.name as contact_name
       FROM contact_notes cn JOIN contacts c ON c.id = cn.contact_id
       WHERE cn.created_at >= ? AND cn.created_at <= ? ORDER BY cn.created_at ASC`
    )
    .bind(windowStart, windowEnd)
    .all<{ id: string; contact_id: string; text: string; created_at: string; contact_name: string }>();
  const contactNotes = (contactNoteRows ?? []).filter((n) => localDateString(n.created_at) === date);

  const { results: habits } = await c.env.DB.prepare('SELECT * FROM journal_habits WHERE active = 1 ORDER BY position ASC').all<Habit>();
  const { results: habitLogRows } = await c.env.DB.prepare('SELECT * FROM journal_habit_logs WHERE date = ?').bind(date).all<HabitLog>();
  const habitLogsByHabit = new Map((habitLogRows ?? []).map((l) => [l.habit_id, l]));
  const habitsWithLogs = (habits ?? []).map((h) => ({ ...h, log: habitLogsByHabit.get(h.id) ?? null }));

  // journal_health_logs (per-day) is dead — Google Health only ever hands
  // us per-week reports (see the 0025 migration), so a viewed day is
  // matched against the weekly-report row whose range contains it instead.
  const health = await c.env.DB.prepare('SELECT * FROM health_weekly_reports WHERE week_start <= ? AND week_end >= ?')
    .bind(date, date)
    .first<HealthWeeklyReport>();

  return c.json({
    date,
    entry: entry ?? null,
    tasksCompleted: completions ?? [],
    tasksPushed: reschedules ?? [],
    notes,
    contactNotes,
    habits: habitsWithLogs,
    health: health ?? null,
  });
});

// PATCH /api/journal/:date — upserts the freeform content and/or the
// day's mood rating. `content` and `mood` are both optional so the mood
// picker can save on its own click without also re-sending (and
// re-touching updated_at unnecessarily around) whatever's in the editor —
// only the fields actually present in the body are written; an explicit
// `mood: null` clears a previously-set rating.
app.patch('/api/journal/:date', async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  const body = await c.req.json<{ content?: string; mood?: number | null }>();
  const ts = now();

  const existing = await c.env.DB.prepare('SELECT * FROM journal_entries WHERE date = ?').bind(date).first<JournalEntry>();
  const content = body.content !== undefined ? body.content : (existing?.content ?? null);
  const searchText = content !== null ? extractPlainText(content) : null;
  const mood = body.mood !== undefined ? body.mood : (existing?.mood ?? null);

  await c.env.DB.prepare(
    `INSERT INTO journal_entries (date, content, search_text, mood, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET content = excluded.content, search_text = excluded.search_text, mood = excluded.mood, updated_at = excluded.updated_at`
  )
    .bind(date, content, searchText, mood, ts, ts)
    .run();

  const entry = await c.env.DB.prepare('SELECT * FROM journal_entries WHERE date = ?').bind(date).first<JournalEntry>();
  return c.json(entry);
});

// ---- Habits ----
app.get('/api/habits', async (c) => {
  const includeArchived = c.req.query('archived') === '1';
  const sql = includeArchived
    ? 'SELECT * FROM journal_habits ORDER BY position ASC'
    : 'SELECT * FROM journal_habits WHERE active = 1 ORDER BY position ASC';
  const { results } = await c.env.DB.prepare(sql).all<Habit>();
  return c.json(results ?? []);
});

app.post('/api/habits', async (c) => {
  const body = await c.req.json<{ name: string; unit?: string | null; target_value?: number | null }>();
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  const id = uid();
  const ts = now();
  const { results: maxPos } = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM journal_habits').all<{ maxPos: number }>();
  const position = (maxPos?.[0]?.maxPos ?? -1) + 1;
  await c.env.DB.prepare(
    `INSERT INTO journal_habits (id, name, unit, target_value, active, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(id, body.name.trim(), body.unit ?? null, body.target_value ?? null, position, ts, ts)
    .run();
  const habit = await c.env.DB.prepare('SELECT * FROM journal_habits WHERE id = ?').bind(id).first<Habit>();
  return c.json(habit, 201);
});

app.patch('/api/habits/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<Pick<Habit, 'name' | 'unit' | 'target_value' | 'active' | 'position'>>>();
  const existing = await c.env.DB.prepare('SELECT id FROM journal_habits WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of ['name', 'unit', 'target_value', 'active', 'position'] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) return c.json({ error: 'no fields to update' }, 400);
  fields.push('updated_at = ?');
  values.push(now());
  values.push(id);
  await c.env.DB.prepare(`UPDATE journal_habits SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();

  const habit = await c.env.DB.prepare('SELECT * FROM journal_habits WHERE id = ?').bind(id).first<Habit>();
  return c.json(habit);
});

app.delete('/api/habits/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM journal_habit_logs WHERE habit_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM journal_habits WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// POST /api/habits/:id/logs — upserts this habit's value for a given day
// (body: { date, value }). A second log for the same habit/day overwrites
// rather than accumulating — (habit_id, date) is the row's whole identity,
// see migrations/0020_journal.sql.
app.post('/api/habits/:id/logs', async (c) => {
  const habitId = c.req.param('id');
  const body = await c.req.json<{ date: string; value: number }>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '')) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  if (typeof body.value !== 'number' || Number.isNaN(body.value)) return c.json({ error: 'value must be a number' }, 400);
  const habit = await c.env.DB.prepare('SELECT id FROM journal_habits WHERE id = ?').bind(habitId).first();
  if (!habit) return c.json({ error: 'habit not found' }, 404);

  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO journal_habit_logs (habit_id, date, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(habitId, body.date, body.value, ts, ts)
    .run();

  const log = await c.env.DB.prepare('SELECT * FROM journal_habit_logs WHERE habit_id = ? AND date = ?').bind(habitId, body.date).first<HabitLog>();
  return c.json(log);
});

app.delete('/api/habits/:id/logs/:date', async (c) => {
  const habitId = c.req.param('id');
  const date = c.req.param('date');
  await c.env.DB.prepare('DELETE FROM journal_habit_logs WHERE habit_id = ? AND date = ?').bind(habitId, date).run();
  return c.json({ ok: true });
});

// ---- News (RSS reader) ----
// See worker/migrations/0026_news.sql for the schema rationale and
// worker/src/news.ts for the RSS/Atom parser. Modeled on V1 MikeOS's
// Feedly-style reader (server-cached articles, folder-grouped feeds,
// swipe-to-mark-read / swipe-to-save) rebuilt against real D1 tables so
// read/saved state has a stable, cross-device id — V1 kept that state in a
// generic KV-style store instead.

const NEWS_FEED_TTL_MS = 15 * 60 * 1000; // matches V1's server-side cache window

function newsFeedToApi(row: NewsFeedRow & { unread_count?: number }) {
  return { ...row, unread_count: row.unread_count ?? 0 };
}

/** Fetches + parses one feed and upserts its items into news_articles.
 * Best-effort: on any failure it records the error on the feed row and
 * rethrows, so callers can decide whether to surface it (a fresh add) or
 * just note it and keep serving cached articles (a routine background
 * refresh). Skipped entirely if the feed was refreshed within the last
 * NEWS_FEED_TTL_MS, same 15-minute window V1 used. */
async function refreshFeed(env: Env, feed: NewsFeedRow, force = false): Promise<void> {
  if (!force && feed.last_fetched_at) {
    const age = Date.now() - new Date(feed.last_fetched_at).getTime();
    if (age < NEWS_FEED_TTL_MS) return;
  }
  const ts = now();
  try {
    const res = await fetch(feed.url, { headers: { 'user-agent': 'MikeOS-News/1.0 (+https://mikeos)' } });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await parseFeed(xml);

    for (const item of parsed.items) {
      const articleId = uid();
      await env.DB.prepare(
        `INSERT INTO news_articles (id, feed_id, guid, url, title, description, image_url, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (feed_id, guid) DO UPDATE SET
           url = excluded.url, title = excluded.title, description = excluded.description,
           image_url = excluded.image_url, published_at = excluded.published_at, fetched_at = excluded.fetched_at`
      )
        .bind(articleId, feed.id, item.guid, item.url, item.title, item.description, item.imageUrl, item.publishedAt, ts)
        .run();
    }

    // Only overwrite the feed's own title if it's still the placeholder
    // from when it was added — never clobber a title Mike has since
    // customized in Settings.
    const titleUpdate = feed.title === feed.url || feed.title.trim() === '' ? parsed.title : feed.title;
    await env.DB.prepare(
      `UPDATE news_feeds SET title = ?, site_url = ?, last_fetched_at = ?, last_fetch_error = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(titleUpdate, parsed.siteUrl, ts, ts, feed.id)
      .run();
  } catch (err) {
    const message = err instanceof FeedParseError ? err.message : err instanceof Error ? err.message : 'Fetch failed';
    await env.DB.prepare(`UPDATE news_feeds SET last_fetch_error = ?, last_fetched_at = ?, updated_at = ? WHERE id = ?`)
      .bind(message, ts, ts, feed.id)
      .run();
    throw err;
  }
}

app.get('/api/news/feeds', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.*, (
       SELECT COUNT(*) FROM news_articles a
       WHERE a.feed_id = f.id AND a.id NOT IN (SELECT article_id FROM news_read)
     ) as unread_count
     FROM news_feeds f ORDER BY f.folder IS NULL, f.folder ASC, f.position ASC, f.title ASC`
  ).all<NewsFeedRow & { unread_count: number }>();
  return c.json((results ?? []).map(newsFeedToApi));
});

app.post('/api/news/feeds', async (c) => {
  const body = await c.req.json<{ url?: string; folder?: string | null }>();
  const url = body.url?.trim();
  if (!url) return c.json({ error: 'url required' }, 400);

  const id = uid();
  const ts = now();
  const feed: NewsFeedRow = {
    id, url, title: url, folder: body.folder?.trim() || null, site_url: null, favicon_url: null,
    position: 0, last_fetch_error: null, last_fetched_at: null, created_at: ts, updated_at: ts,
  };
  await c.env.DB.prepare(
    `INSERT INTO news_feeds (id, url, title, folder, site_url, favicon_url, position, last_fetch_error, last_fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(feed.id, feed.url, feed.title, feed.folder, feed.site_url, feed.favicon_url, feed.position, feed.last_fetch_error, feed.last_fetched_at, feed.created_at, feed.updated_at)
    .run();

  // Fetch immediately (forced, ignoring the TTL) so a bad URL is caught
  // right away rather than silently sitting empty until the next poll.
  try {
    await refreshFeed(c.env, feed, true);
  } catch (err) {
    // Feed row stays — Mike can fix the URL via Settings rather than
    // losing the add entirely — but surface the failure on this response.
    const saved = await c.env.DB.prepare('SELECT * FROM news_feeds WHERE id = ?').bind(id).first<NewsFeedRow>();
    return c.json({ ...newsFeedToApi({ ...(saved ?? feed), unread_count: 0 }), error: err instanceof Error ? err.message : 'Fetch failed' }, 201);
  }

  const saved = await c.env.DB.prepare('SELECT * FROM news_feeds WHERE id = ?').bind(id).first<NewsFeedRow>();
  return c.json(newsFeedToApi({ ...(saved as NewsFeedRow), unread_count: 0 }), 201);
});

app.patch('/api/news/feeds/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; folder?: string | null; position?: number }>();
  const existing = await c.env.DB.prepare('SELECT id FROM news_feeds WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title.trim() || 'Untitled Feed'); }
  if (body.folder !== undefined) { sets.push('folder = ?'); vals.push(body.folder?.trim() || null); }
  if (body.position !== undefined) { sets.push('position = ?'); vals.push(body.position); }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    vals.push(now());
    await c.env.DB.prepare(`UPDATE news_feeds SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  }
  const feed = await c.env.DB.prepare('SELECT * FROM news_feeds WHERE id = ?').bind(id).first<NewsFeedRow>();
  return c.json(newsFeedToApi({ ...(feed as NewsFeedRow), unread_count: 0 }));
});

app.delete('/api/news/feeds/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM news_feeds WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  // Saved articles keep their own title/url/image snapshot, so unlink
  // rather than delete them when their feed goes away.
  await c.env.DB.prepare(
    `UPDATE news_saved SET article_id = NULL WHERE article_id IN (SELECT id FROM news_articles WHERE feed_id = ?)`
  ).bind(id).run();
  await c.env.DB.prepare('DELETE FROM news_articles WHERE feed_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM news_feeds WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/news/articles', async (c) => {
  const feedId = c.req.query('feed_id');
  const folder = c.req.query('folder');
  const unreadOnly = c.req.query('unread_only') === '1';

  let targetFeeds: NewsFeedRow[];
  if (feedId) {
    const f = await c.env.DB.prepare('SELECT * FROM news_feeds WHERE id = ?').bind(feedId).first<NewsFeedRow>();
    targetFeeds = f ? [f] : [];
  } else if (folder !== undefined) {
    const { results } = await c.env.DB.prepare('SELECT * FROM news_feeds WHERE folder IS ? OR folder = ?').bind(null, folder).all<NewsFeedRow>();
    targetFeeds = (results ?? []).filter((f) => (folder === '' ? f.folder === null : f.folder === folder));
  } else {
    const { results } = await c.env.DB.prepare('SELECT * FROM news_feeds').all<NewsFeedRow>();
    targetFeeds = results ?? [];
  }

  const staleFeeds: string[] = [];
  await Promise.all(
    targetFeeds.map(async (f) => {
      try {
        await refreshFeed(c.env, f);
      } catch {
        staleFeeds.push(f.id);
      }
    })
  );

  if (targetFeeds.length === 0) return c.json({ articles: [], stale_feeds: [] });

  const placeholders = targetFeeds.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, f.title as feed_title, f.folder as feed_folder,
            (r.article_id IS NOT NULL) as is_read, (s.article_id IS NOT NULL) as is_saved
     FROM news_articles a
     JOIN news_feeds f ON f.id = a.feed_id
     LEFT JOIN news_read r ON r.article_id = a.id
     LEFT JOIN news_saved s ON s.article_id = a.id
     WHERE a.feed_id IN (${placeholders})
     ${unreadOnly ? 'AND r.article_id IS NULL' : ''}
     ORDER BY a.published_at IS NULL, a.published_at DESC, a.fetched_at DESC
     LIMIT 500`
  )
    .bind(...targetFeeds.map((f) => f.id))
    .all<NewsArticleRow & { feed_title: string; feed_folder: string | null; is_read: number; is_saved: number }>();

  const articles = (results ?? []).map((r) => ({ ...r, is_read: !!r.is_read, is_saved: !!r.is_saved }));
  return c.json({ articles, stale_feeds: staleFeeds });
});

app.post('/api/news/articles/:id/read', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ read?: boolean }>();
  if (body.read === false) {
    await c.env.DB.prepare('DELETE FROM news_read WHERE article_id = ?').bind(id).run();
  } else {
    await c.env.DB.prepare('INSERT OR IGNORE INTO news_read (article_id, read_at) VALUES (?, ?)').bind(id, now()).run();
  }
  return c.json({ ok: true });
});

app.post('/api/news/read-all', async (c) => {
  const body = await c.req.json<{ feed_id?: string | null; folder?: string | null }>();
  let feedIds: string[];
  if (body.feed_id) {
    feedIds = [body.feed_id];
  } else if (body.folder !== undefined && body.folder !== null) {
    const { results } = await c.env.DB.prepare('SELECT id FROM news_feeds WHERE folder = ?').bind(body.folder).all<{ id: string }>();
    feedIds = (results ?? []).map((r) => r.id);
  } else {
    const { results } = await c.env.DB.prepare('SELECT id FROM news_feeds').all<{ id: string }>();
    feedIds = (results ?? []).map((r) => r.id);
  }
  if (feedIds.length === 0) return c.json({ ok: true, marked: 0 });

  const placeholders = feedIds.map(() => '?').join(',');
  const ts = now();
  const result = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO news_read (article_id, read_at)
     SELECT id, ? FROM news_articles WHERE feed_id IN (${placeholders})`
  )
    .bind(ts, ...feedIds)
    .run();
  return c.json({ ok: true, marked: result.meta.changes ?? 0 });
});

app.post('/api/news/articles/:id/save', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM news_saved WHERE article_id = ?').bind(id).first<NewsSavedRow>();
  if (existing) return c.json(existing);

  const article = await c.env.DB.prepare(
    `SELECT a.*, f.title as feed_title FROM news_articles a JOIN news_feeds f ON f.id = a.feed_id WHERE a.id = ?`
  )
    .bind(id)
    .first<NewsArticleRow & { feed_title: string }>();
  if (!article) return c.json({ error: 'article not found' }, 404);

  const savedId = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO news_saved (id, article_id, feed_title, title, url, image_url, description, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(savedId, article.id, article.feed_title, article.title, article.url, article.image_url, article.description, ts)
    .run();
  const saved = await c.env.DB.prepare('SELECT * FROM news_saved WHERE id = ?').bind(savedId).first<NewsSavedRow>();
  return c.json(saved, 201);
});

app.get('/api/news/saved', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM news_saved ORDER BY saved_at DESC').all<NewsSavedRow>();
  return c.json(results ?? []);
});

app.delete('/api/news/saved/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM news_saved WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Top Stories (Today page's "biggest headlines right now" block) ----
//
// Deliberately separate from the News feature above: this isn't something
// Mike subscribes to or manages (no entry in news_feeds, doesn't show in
// the Feeds modal) — just a small server-cached top-10 the Today page pulls
// on its own. Sourced from NPR's "Top Stories" RSS feed — not an aggregator
// like Google News (whose <item> entries are typically just a title + a
// link/source stub with no real image or summary, leaving every
// thumbnail/preview blank) and not AP or Reuters (both killed their public
// RSS feeds years ago; nothing official is left to point at). NPR was
// picked over BBC/NYT specifically for source diversity from Mike's own
// RSS subscriptions and bias: free with no paywall (BBC added a US paywall
// in 2025), "U.S. and world" in scope rather than UK-centric, and rated
// "center" by AllSides — as close to AP's old reputation as a real, still-
// working, keyless RSS feed gets. Reuses the exact same parseFeed() as the
// News feature — nothing about this feed needed new parsing logic.
//
// Specifically feed id 1001 ("NPR Topics: News" — "breaking stories,
// national and world news, politics, business, science, technology"), not
// 1002 ("Top Stories") which turned out to also fold in "music, arts and
// culture" — that's what put a Ms. Rachel album piece at #2 the first time
// this shipped. 1001's own sample pull is overwhelmingly hard/breaking
// news, a much closer match to "the water-cooler stories" than a general
// homepage-style mix.
const TOP_NEWS_TTL_MS = 60 * 60 * 1000; // 60 min — doesn't need to be as fresh as a personal RSS reader, and this avoids an outbound fetch on every single Today page load
const TOP_NEWS_SOURCE_URL = 'https://feeds.npr.org/1001/rss.xml';
const TOP_NEWS_SOURCE_NAME = 'NPR';
const TOP_NEWS_STORY_COUNT = 10;
// Bumped from 'singleton' to force one immediate cache miss on deploy —
// there's no way to reach production D1 directly from this environment to
// clear the old row by hand, and the previous row was still holding
// full-resolution image URLs from before the weserv thumbnail-proxy fix
// (confirmed live: a 5154x3436 original still being served, well within
// its 60-minute TTL). Changing the key is the only available way to
// invalidate it on this deploy; it's fine to leave at 'singleton' again
// after this ships.
const TOP_NEWS_CACHE_ROW_ID = 'singleton-v2';

interface TopNewsItem {
  headline: string;
  url: string;
  source: string;
  preview: string | null;
  imageUrl: string | null;
}

// NPR's feed images are full article-hero resolution — easily a few
// hundred KB each — even though this list only ever displays them at
// 44px. Adding width/height/loading="lazy" to the <img> (an earlier fix)
// stopped layout shift and deferred off-screen fetches, but every image
// that scrolls into view still has to download and decode its full-size
// original, and doing that for one thumbnail after another during a
// scroll pass is exactly what shows up as "laggy scrolling." Routing
// through images.weserv.nl (a free, keyless resizing proxy) at cache-
// write time means the URL we ever hand the browser is already an 88x88
// (2x for retina) webp — a few KB instead of a few hundred — so this is
// baked into the cached payload once per refresh, not recomputed per
// request.
function toThumbnailUrl(sourceUrl: string): string {
  const withoutScheme = sourceUrl.replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(withoutScheme)}&w=88&h=88&fit=cover&q=75&output=webp`;
}

async function computeTopNews(db: D1Database): Promise<TopNewsItem[]> {
  const cached = await db
    .prepare('SELECT payload, fetched_at FROM top_news_cache WHERE id = ?')
    .bind(TOP_NEWS_CACHE_ROW_ID)
    .first<{ payload: string; fetched_at: string }>();

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TOP_NEWS_TTL_MS) {
    return JSON.parse(cached.payload) as TopNewsItem[];
  }

  let items: TopNewsItem[];
  try {
    const res = await fetch(TOP_NEWS_SOURCE_URL, { headers: { 'User-Agent': 'MikeOS/1.0' } });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const parsed = await parseFeed(await res.text());
    items = parsed.items.slice(0, TOP_NEWS_STORY_COUNT).map((item) => ({
      headline: item.title,
      url: item.url,
      source: TOP_NEWS_SOURCE_NAME,
      preview: item.description,
      imageUrl: item.imageUrl ? toThumbnailUrl(item.imageUrl) : null,
    }));
  } catch {
    // A fetch/parse failure falls back to whatever's still in the cache
    // (even if stale) rather than showing nothing, same "degrade gracefully"
    // instinct as Weather's own try/catch. Only truly empty (never fetched
    // successfully even once) returns [].
    return cached ? (JSON.parse(cached.payload) as TopNewsItem[]) : [];
  }

  await db
    .prepare('INSERT INTO top_news_cache (id, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at')
    .bind(TOP_NEWS_CACHE_ROW_ID, JSON.stringify(items), now())
    .run();

  return items;
}

app.get('/api/top-news', async (c) => {
  return c.json({ items: await computeTopNews(c.env.DB) });
});

// ---- Global search (Cmd/Ctrl+K palette) ----
//
// Fans out one plain LIKE query per source table rather than one giant
// UNION across heterogeneous schemas — matches this codebase's existing
// per-module-route style (see /api/stats/completions above) and stays
// simple to reason about/extend as new modules show up. Plenty fast at
// personal-app scale; add FTS5 only if this ever actually gets slow.
//
// Every source funnels into one of nine result "groups" — the same set the
// search palette's filter chips offer (notes/jots/lists/projects/boards/
// contacts/journal/meeting_notes/links). `entities` alone covers five of
// them (notes, jots, projects, lists, and list/project tasks) plus file
// attachments, which are folded into whichever group their parent belongs
// to rather than getting a chip of their own — a match on a filename reads
// naturally as "found inside Notes/Projects/etc", not a separate concept.
const SEARCH_GROUPS = ['notes', 'jots', 'lists', 'projects', 'boards', 'contacts', 'journal', 'meeting_notes', 'links'] as const;
type SearchGroup = (typeof SEARCH_GROUPS)[number];

interface SearchResult {
  id: string;
  kind: string;
  group: SearchGroup;
  title: string;
  snippet: string | null;
  parentTitle: string | null;
  path: string;
  openId: string | null; // set when `path` needs a taskStack opened after navigating (see ListDetail/ProjectDetail's location.state handling)
  updatedAt: string;
  score: number;
}

function matchScore(title: string, body: string | null, q: string): number {
  const t = title.toLowerCase();
  const qq = q.toLowerCase();
  if (t === qq) return 100;
  if (t.startsWith(qq)) return 80;
  if (t.includes(qq)) return 60;
  if (body && body.toLowerCase().includes(qq)) return 30;
  return 0;
}

// A short excerpt centered on the match, for body-text hits where the
// title itself didn't match — lets a result show *why* it's here instead
// of just that it is. Title-only matches skip this (nothing more useful
// to show than the title, which is already the result's heading).
function snippetAround(body: string, q: string, radius = 60): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return body.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + q.length + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

interface SearchGroupResultRow {
  key: SearchGroup;
  results: SearchResult[];
}

// The actual work behind GET /api/search, pulled out into its own function
// so the Daily Briefing's "anything related to this meeting" matching (see
// computeBriefing below) can call the exact same scored LIKE-matching
// logic per keyword instead of re-implementing a second search engine.
async function runSearch(db: D1Database, q: string, scope: Set<SearchGroup>, includeArchived: boolean): Promise<SearchGroupResultRow[]> {
  const like = `%${q}%`;
  const results: SearchResult[] = [];

  const wantsEntities = scope.has('notes') || scope.has('jots') || scope.has('lists') || scope.has('projects');
  const wantsBoards = scope.has('boards');
  const wantsContacts = scope.has('contacts');
  const wantsJournal = scope.has('journal');
  const wantsMeetings = scope.has('meeting_notes');
  const wantsLinks = scope.has('links');

  const [entityRows, boardRows, boardItemRows, contactRows, contactNoteRows, journalRows, meetingRows, linkRows] = await Promise.all([
    wantsEntities
      ? db
          .prepare(
            `SELECT e.*, p.type as parent_type, p.is_jot as parent_is_jot, p.is_list as parent_is_list, p.title as parent_title
             FROM entities e LEFT JOIN entities p ON p.id = e.parent_id
             WHERE e.type IN ('note','task','project','file','vault_entry') AND (e.title LIKE ? OR e.search_text LIKE ?)
             ORDER BY e.updated_at DESC LIMIT 80`
          )
          .bind(like, like)
          .all<Entity & { parent_type: string | null; parent_is_jot: number | null; parent_is_list: number | null; parent_title: string | null }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsBoards
      ? db.prepare(`SELECT * FROM canvas_boards WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 25`).bind(like).all<{ id: string; title: string; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsBoards
      ? db
          .prepare(
            `SELECT i.id, i.type, i.content, i.board_id, b.title as board_title, b.updated_at
             FROM canvas_items i JOIN canvas_boards b ON b.id = i.board_id
             WHERE (i.type IN ('text','note') AND json_extract(i.content, '$.text') LIKE ?)
                OR (i.type = 'image' AND json_extract(i.content, '$.filename') LIKE ?)
             ORDER BY b.updated_at DESC LIMIT 25`
          )
          .bind(like, like)
          .all<{ id: string; type: string; content: string; board_id: string; board_title: string; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    // Fetched in full (personal contacts only, not the voter roll — same
    // default GET /api/contacts itself uses) rather than LIKE-filtered:
    // fuzzyNameScore's typo tolerance can't be expressed in SQL, so scoring
    // happens in JS below. Fine at this app's contacts-table scale.
    wantsContacts
      ? db.prepare(`SELECT * FROM contacts WHERE source != 'voter_file' LIMIT 500`).all<{ id: string; name: string; company: string | null; title: string | null; headline: string | null; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsContacts
      ? db
          .prepare(`SELECT n.*, c.name as contact_name FROM contact_notes n JOIN contacts c ON c.id = n.contact_id WHERE n.text LIKE ? ORDER BY n.created_at DESC LIMIT 25`)
          .bind(like)
          .all<{ id: string; contact_id: string; text: string; contact_name: string; created_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsJournal
      ? db.prepare(`SELECT * FROM journal_entries WHERE search_text LIKE ? OR date LIKE ? ORDER BY date DESC LIMIT 25`).bind(like, like).all<{ date: string; content: string; search_text: string | null; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsMeetings
      ? db.prepare(`SELECT * FROM meeting_notes WHERE text LIKE ? OR meeting_title LIKE ? ORDER BY updated_at DESC LIMIT 25`).bind(like, like).all<{ id: string; meeting_id: string; meeting_title: string | null; text: string; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
    wantsLinks
      ? db.prepare(`SELECT * FROM quick_links WHERE name LIKE ? OR url LIKE ? ORDER BY updated_at DESC LIMIT 25`).bind(like, like).all<{ id: string; name: string; url: string; updated_at: string }>()
      : Promise.resolve({ results: [] as any[] }),
  ]);

  // ---- entities: notes / jots / lists / projects / their tasks / files ----
  for (const e of entityRows.results ?? []) {
    if (!includeArchived && (e.status === 'done' || e.status === 'archived')) continue;

    let kind: string;
    let group: SearchGroup;
    let parentTitle: string | null = null;
    let path = '/';
    let openId: string | null = null;

    // A Vault entry has no per-child route (its notes open in a modal, not
    // a page) — the closest real destination for anything filed under one
    // is the entry itself, so every branch below routes a vault_entry
    // parent (or the entry's own row) to /vault/:id instead of falling
    // through to a /projects/:id that doesn't exist for that id.
    const parentIsVaultEntry = e.parent_type === 'vault_entry';

    if (e.type === 'vault_entry') {
      kind = 'vault_entry';
      group = 'projects';
      path = `/vault/${e.id}`;
    } else if (e.type === 'note') {
      kind = e.is_jot ? 'jot' : 'note';
      group = e.is_jot ? 'jots' : parentIsVaultEntry ? 'projects' : 'notes';
      parentTitle = parentIsVaultEntry ? e.parent_title : parentTitle;
      path = e.is_jot ? '/jots' : parentIsVaultEntry ? `/vault/${e.parent_id}` : `/notes/${e.id}`;
      if (e.is_jot) openId = e.id; // Jots has no per-item route — opened via location.state on /jots instead
    } else if (e.type === 'project') {
      kind = e.is_list ? 'list' : 'project';
      group = e.is_list ? 'lists' : 'projects';
      path = e.is_list ? `/lists/${e.id}` : `/projects/${e.id}`;
    } else if (e.type === 'task') {
      const parentIsList = e.parent_is_list === 1;
      kind = parentIsList ? 'list_item' : 'task';
      group = parentIsList ? 'lists' : 'projects';
      parentTitle = e.parent_title;
      path = parentIsList ? `/lists/${e.parent_id}` : parentIsVaultEntry ? `/vault/${e.parent_id}` : `/projects/${e.parent_id}`;
      openId = parentIsVaultEntry ? null : e.id; // Vault has no task-detail deep-link (yet) — land on the entry itself
    } else {
      // type === 'file' — folds into whichever group its immediate parent
      // belongs to; a file attached directly to a task (one level deeper)
      // falls back to Projects rather than chasing a grandparent lookup.
      kind = 'file';
      parentTitle = e.parent_title;
      if (e.parent_type === 'note') {
        group = e.parent_is_jot ? 'jots' : 'notes';
        path = e.parent_is_jot ? '/jots' : `/notes/${e.parent_id}`;
        if (e.parent_is_jot) openId = e.parent_id;
      } else if (e.parent_type === 'project') {
        group = e.parent_is_list ? 'lists' : 'projects';
        path = e.parent_is_list ? `/lists/${e.parent_id}` : `/projects/${e.parent_id}`;
      } else if (parentIsVaultEntry) {
        group = 'projects';
        path = `/vault/${e.parent_id}`;
      } else {
        group = 'projects';
        path = e.parent_id ? `/projects/${e.parent_id}` : '/projects';
      }
    }

    if (!scope.has(group)) continue;
    const score = matchScore(e.title ?? '', e.search_text ?? null, q);
    if (score === 0) continue;
    const snippet = score < 60 && e.search_text ? snippetAround(e.search_text, q) : null;
    results.push({ id: e.id, kind, group, title: e.title || (kind === 'file' ? 'Untitled File' : 'Untitled'), snippet, parentTitle, path, openId, updatedAt: e.updated_at, score });
  }

  // ---- boards ----
  for (const b of boardRows.results ?? []) {
    const score = matchScore(b.title ?? '', null, q);
    if (score === 0) continue;
    results.push({ id: b.id, kind: 'board', group: 'boards', title: b.title || 'Untitled Board', snippet: null, parentTitle: null, path: `/boards/${b.id}`, openId: null, updatedAt: b.updated_at, score });
  }
  for (const item of boardItemRows.results ?? []) {
    let content: { text?: string; filename?: string } = {};
    try {
      content = JSON.parse(item.content);
    } catch {}
    const title = content.text || content.filename || 'Untitled Item';
    const score = matchScore(title, null, q);
    if (score === 0) continue;
    results.push({
      id: item.id,
      kind: 'board_item',
      group: 'boards',
      title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
      snippet: null,
      parentTitle: item.board_title,
      path: `/boards/${item.board_id}`,
      openId: null,
      updatedAt: item.updated_at,
      score,
    });
  }

  // ---- contacts (fuzzy-matched — see fuzzyNameScore's comment) ----
  for (const ct of contactRows.results ?? []) {
    const body = [ct.headline, ct.company, ct.title].filter(Boolean).join(' · ');
    const score = Math.max(fuzzyNameScore(ct.name ?? '', q), textIncludes(ct.company, q) || textIncludes(ct.title, q) || textIncludes(ct.headline, q) ? 40 : 0);
    if (score === 0) continue;
    results.push({ id: ct.id, kind: 'contact', group: 'contacts', title: ct.name || 'Untitled Contact', snippet: score < 60 ? body || null : null, parentTitle: null, path: `/contacts/${ct.id}`, openId: null, updatedAt: ct.updated_at, score });
  }
  for (const n of contactNoteRows.results ?? []) {
    const score = matchScore('', n.text, q);
    if (score === 0) continue;
    results.push({
      id: n.id,
      kind: 'contact_note',
      group: 'contacts',
      title: n.contact_name || 'Untitled Contact',
      snippet: snippetAround(n.text, q),
      parentTitle: null,
      path: `/contacts/${n.contact_id}`,
      openId: null,
      updatedAt: n.created_at,
      score,
    });
  }

  // ---- journal ----
  for (const j of journalRows.results ?? []) {
    const title = new Date(`${j.date}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const score = matchScore(title, j.search_text, q);
    if (score === 0) continue;
    results.push({
      id: j.date,
      kind: 'journal',
      group: 'journal',
      title,
      snippet: score < 60 && j.search_text ? snippetAround(j.search_text, q) : null,
      parentTitle: null,
      path: `/journal/${j.date}`,
      openId: null,
      updatedAt: j.updated_at,
      score,
    });
  }

  // ---- meeting notes ----
  for (const m of meetingRows.results ?? []) {
    const title = m.meeting_title || 'Untitled Meeting';
    const score = matchScore(title, m.text, q);
    if (score === 0) continue;
    results.push({
      id: m.id,
      kind: 'meeting_note',
      group: 'meeting_notes',
      title,
      snippet: score < 60 ? snippetAround(m.text, q) : null,
      parentTitle: null,
      path: '/today',
      openId: null,
      updatedAt: m.updated_at,
      score,
    });
  }

  // ---- quick links (sidebar Links tray) ----
  for (const l of linkRows.results ?? []) {
    const score = matchScore(l.name ?? '', l.url, q);
    if (score === 0) continue;
    results.push({ id: l.id, kind: 'quick_link', group: 'links', title: l.name || l.url, snippet: score < 60 ? l.url : null, parentTitle: null, path: '/links', openId: null, updatedAt: l.updated_at, score });
  }

  results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));

  return SEARCH_GROUPS.filter((g) => scope.has(g)).map((key) => ({ key, results: results.filter((r) => r.group === key) }));
}

app.get('/api/search', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ groups: [] });

  const scopeParam = c.req.query('scope')?.trim();
  const scope = new Set<SearchGroup>(
    scopeParam ? (scopeParam.split(',').filter((s) => (SEARCH_GROUPS as readonly string[]).includes(s)) as SearchGroup[]) : SEARCH_GROUPS
  );
  const includeArchived = c.req.query('archived') === '1';

  const groups = await runSearch(c.env.DB, q, scope, includeArchived);
  return c.json({ groups });
});

// ---- Daily Briefing (rule-based "chief of staff" — no LLM, just data
// MikeOS already has, assembled and ranked) ----
//
// Everything here is deterministic: today's real meetings (from the ICS
// feeds), whoever's on each invite matched back to a Contacts record by
// email, that person's own contact notes, and anything in Notes/Jots/
// Lists/Projects/Boards/Links/Meeting Notes whose title or body mentions
// the meeting/attendees — the exact same scored LIKE search the Cmd/Ctrl+K
// palette uses (see runSearch above), just triggered by the meeting's own
// keywords instead of something Mike typed. Plus a handful of day-level
// nudges (overdue tasks, birthdays/anniversaries coming up, projects gone
// quiet) and a plain-numbers retrospective on the trailing week. No text
// is ever generated — the frontend supplies the "assistant voice" phrasing
// around whatever this returns.

interface BriefingRelated {
  id: string;
  group: SearchGroup;
  title: string;
  path: string;
  openId: string | null;
}

interface BriefingMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  gcalUrl: string | null;
  hasNote: boolean;
  noteEntityId: string | null;
  location: string | null;
  links: string[];
  attendees: { name: string | null; email: string; contactId: string | null; contactName: string | null }[];
  contactNotes: { contactId: string; contactName: string; text: string; createdAt: string }[];
  related: BriefingRelated[];
}

const BRIEFING_RELATED_SCOPE = new Set<SearchGroup>(['notes', 'jots', 'lists', 'projects', 'boards', 'links', 'meeting_notes']);
const BRIEFING_RELATED_LIMIT = 6;
const UPCOMING_DATE_WINDOW_DAYS = 7;
const STALE_PROJECT_DAYS = 14;
const STALE_PROJECT_LIMIT = 3;
const RETROSPECTIVE_DAYS = 7;

// Runs one search per keyword (meeting title + attendee names + matched
// contacts' companies) and merges the results into one deduped, re-sorted
// list — a meeting is rarely well described by a single term, and this is
// far cheaper than teaching runSearch itself to OR multiple terms together
// for what's a secondary use of it.
async function findRelatedContent(db: D1Database, keywords: string[]): Promise<BriefingRelated[]> {
  const seen = new Map<string, BriefingRelated & { score: number }>();
  for (const kw of keywords) {
    const q = kw.trim();
    if (q.length < 3) continue; // too short to mean anything as a LIKE term
    const groups = await runSearch(db, q, BRIEFING_RELATED_SCOPE, false);
    for (const g of groups) {
      for (const r of g.results) {
        const key = `${r.group}:${r.id}`;
        const existing = seen.get(key);
        if (!existing || r.score > existing.score) {
          seen.set(key, { id: r.id, group: r.group, title: r.title, path: r.path, openId: r.openId, score: r.score });
        }
      }
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, BRIEFING_RELATED_LIMIT)
    .map(({ score: _score, ...rest }) => rest);
}

async function computeBriefing(db: D1Database, date: string) {
  const sources = await fetchFeedSources(db);
  const rawMeetings = await tagHasNote(db, meetingsForDate(sources, date));

  // ---- match every attendee email to a real Contacts record in one pass ----
  const allEmails = [...new Set(rawMeetings.flatMap((m) => m.attendees.map((a) => a.email.toLowerCase())))];
  const contactByEmail = new Map<string, { id: string; name: string; company: string | null }>();
  if (allEmails.length > 0) {
    const placeholders = allEmails.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT DISTINCT c.id, c.name, c.company, lower(je.value) as matched_email
         FROM contacts c, json_each(c.emails) je
         WHERE lower(je.value) IN (${placeholders}) AND c.source != 'voter_file'`
      )
      .bind(...allEmails)
      .all<{ id: string; name: string; company: string | null; matched_email: string }>();
    for (const r of results ?? []) contactByEmail.set(r.matched_email, { id: r.id, name: r.name, company: r.company });
  }

  const matchedContactIds = [...new Set([...contactByEmail.values()].map((c) => c.id))];
  const notesByContact = new Map<string, { contactId: string; contactName: string; text: string; createdAt: string }[]>();
  if (matchedContactIds.length > 0) {
    const placeholders = matchedContactIds.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT cn.contact_id, c.name as contact_name, cn.text, cn.created_at
         FROM contact_notes cn JOIN contacts c ON c.id = cn.contact_id
         WHERE cn.contact_id IN (${placeholders}) ORDER BY cn.created_at DESC`
      )
      .bind(...matchedContactIds)
      .all<{ contact_id: string; contact_name: string; text: string; created_at: string }>();
    for (const r of results ?? []) {
      const list = notesByContact.get(r.contact_id) ?? [];
      if (list.length < 2) list.push({ contactId: r.contact_id, contactName: r.contact_name, text: r.text, createdAt: r.created_at }); // most recent couple only
      notesByContact.set(r.contact_id, list);
    }
  }

  const meetings: BriefingMeeting[] = await Promise.all(
    rawMeetings.map(async (m) => {
      const attendees = m.attendees.map((a) => {
        const contact = contactByEmail.get(a.email.toLowerCase());
        return { name: a.name, email: a.email, contactId: contact?.id ?? null, contactName: contact?.name ?? null };
      });
      const matchedHere = attendees.filter((a): a is typeof a & { contactId: string } => a.contactId != null);
      const contactNotes = matchedHere.flatMap((a) => notesByContact.get(a.contactId) ?? []);

      const keywords = [
        m.title,
        ...attendees.map((a) => a.contactName ?? a.name).filter((n): n is string => !!n),
        ...matchedHere.map((a) => contactByEmail.get(a.email.toLowerCase())?.company).filter((c): c is string => !!c),
      ];
      const related = await findRelatedContent(db, keywords);

      let noteEntityId: string | null = null;
      if (m.hasNote) {
        const row = await db.prepare('SELECT note_entity_id FROM meeting_notes WHERE meeting_id = ?').bind(m.id).first<{ note_entity_id: string | null }>();
        noteEntityId = row?.note_entity_id ?? null;
      }

      return {
        id: m.id,
        title: m.title,
        start: m.start,
        end: m.end,
        allDay: m.allDay,
        gcalUrl: m.gcalUrl,
        hasNote: m.hasNote,
        noteEntityId,
        location: m.location,
        links: m.links,
        attendees,
        contactNotes,
        related,
      };
    })
  );

  // ---- day-level nudges ----
  const [overdueRow, dueTodayRow, staleProjectsRow] = await Promise.all([
    db
      .prepare(`SELECT id, title, due_date FROM entities WHERE type = 'task' AND status NOT IN ('done','archived') AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date ASC LIMIT 5`)
      .bind(date)
      .all<{ id: string; title: string; due_date: string }>(),
    db
      .prepare(`SELECT id, title FROM entities WHERE type = 'task' AND status NOT IN ('done','archived') AND due_date = ? ORDER BY position ASC LIMIT 8`)
      .bind(date)
      .all<{ id: string; title: string }>(),
    db
      .prepare(
        `SELECT id, title, last_touched FROM entities WHERE type = 'project' AND is_list = 0 AND status NOT IN ('done','archived') AND last_touched < ? ORDER BY last_touched ASC LIMIT ?`
      )
      .bind(addDaysStr(date, -STALE_PROJECT_DAYS), STALE_PROJECT_LIMIT)
      .all<{ id: string; title: string; last_touched: string }>(),
  ]);
  const [overdueCountRow, dueTodayCountRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type = 'task' AND status NOT IN ('done','archived') AND due_date IS NOT NULL AND due_date < ?`).bind(date).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type = 'task' AND status NOT IN ('done','archived') AND due_date = ?`).bind(date).first<{ n: number }>(),
  ]);

  // Birthdays/anniversaries in the next 7 days (today included) — pulled
  // as one small full-table scan (same "contacts table is small enough"
  // trade /api/today already makes for its own same-day version of this)
  // rather than 7 separate month/day-equality queries, then matched in JS
  // so a year-end wraparound (Dec 30 looking ahead into Jan) just works.
  const { results: dateContacts } = await db
    .prepare(
      `SELECT id, name, birthday_month, birthday_day, anniversary_month, anniversary_day FROM contacts
       WHERE source != 'voter_file' AND (birthday_month IS NOT NULL OR anniversary_month IS NOT NULL)`
    )
    .all<{ id: string; name: string; birthday_month: number | null; birthday_day: number | null; anniversary_month: number | null; anniversary_day: number | null }>();
  const [dy, dm, dd] = date.split('-').map(Number);
  const todayUtc = Date.UTC(dy, dm - 1, dd);
  function daysUntil(month: number, day: number): number {
    for (const yr of [dy, dy + 1]) {
      const target = Date.UTC(yr, month - 1, day);
      const diff = Math.round((target - todayUtc) / 86400000);
      if (diff >= 0) return diff;
    }
    return 999;
  }
  const upcomingDates: { type: 'birthday' | 'anniversary'; contactId: string; name: string; inDays: number }[] = [];
  for (const c of dateContacts ?? []) {
    if (c.birthday_month && c.birthday_day) {
      const inDays = daysUntil(c.birthday_month, c.birthday_day);
      if (inDays <= UPCOMING_DATE_WINDOW_DAYS) upcomingDates.push({ type: 'birthday', contactId: c.id, name: c.name, inDays });
    }
    if (c.anniversary_month && c.anniversary_day) {
      const inDays = daysUntil(c.anniversary_month, c.anniversary_day);
      if (inDays <= UPCOMING_DATE_WINDOW_DAYS) upcomingDates.push({ type: 'anniversary', contactId: c.id, name: c.name, inDays });
    }
  }
  upcomingDates.sort((a, b) => a.inDays - b.inDays);

  // ---- retrospective: plain aggregation over the trailing week, no
  // generated prose — see the section comment above for why journal
  // content itself is quoted rather than "summarized". ----
  const weekStart = addDaysStr(date, -(RETROSPECTIVE_DAYS - 1));
  const prevWeekStart = addDaysStr(date, -(RETROSPECTIVE_DAYS * 2 - 1));
  const prevWeekEnd = addDaysStr(date, -RETROSPECTIVE_DAYS);
  const [completedThisWeek, completedPrevWeek, journalRows, topProjectsRows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date >= ? AND completed_date <= ?`).bind(weekStart, date).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) as n FROM task_completions WHERE completed_date >= ? AND completed_date <= ?`).bind(prevWeekStart, prevWeekEnd).first<{ n: number }>(),
    db
      .prepare(`SELECT date, mood, content IS NOT NULL AND content != '' as has_content FROM journal_entries WHERE date >= ? AND date <= ? ORDER BY date ASC`)
      .bind(weekStart, date)
      .all<{ date: string; mood: number | null; has_content: number }>(),
    db
      .prepare(
        `SELECT p.id, p.title, COUNT(*) as n FROM task_completions tc
         JOIN entities e ON e.id = tc.entity_id JOIN entities p ON p.id = e.parent_id
         WHERE tc.completed_date >= ? AND tc.completed_date <= ? GROUP BY p.id ORDER BY n DESC LIMIT 3`
      )
      .bind(weekStart, date)
      .all<{ id: string; title: string; n: number }>(),
  ]);
  const moodValues = (journalRows.results ?? []).map((r) => r.mood).filter((m): m is number => m != null);
  const avgMood = moodValues.length > 0 ? moodValues.reduce((a, b) => a + b, 0) / moodValues.length : null;

  return {
    date,
    meetings,
    insights: {
      overdueCount: overdueCountRow?.n ?? 0,
      overdueTasks: overdueRow.results ?? [],
      dueTodayCount: dueTodayCountRow?.n ?? 0,
      dueTodayTasks: dueTodayRow.results ?? [],
      upcomingDates,
      staleProjects: staleProjectsRow.results ?? [],
    },
    retrospective: {
      weekStart,
      tasksCompleted: completedThisWeek?.n ?? 0,
      tasksCompletedPrevWeek: completedPrevWeek?.n ?? 0,
      journalDays: (journalRows.results ?? []).filter((r) => r.has_content).length,
      avgMood,
      moodDays: (journalRows.results ?? []).filter((r) => r.mood != null).map((r) => ({ date: r.date, mood: r.mood as number })),
      topProjects: topProjectsRows.results ?? [],
    },
  };
}

app.get('/api/briefing', async (c) => {
  const date = c.req.query('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date query param is required (YYYY-MM-DD)' }, 400);
  return c.json(await computeBriefing(c.env.DB, date));
});

// ---- Bets (sports betting dashboard, 0032_bets.sql) ----
//
// Deliberately thin: this Worker stores the raw inputs (odds/wager/result)
// and does basically no computation server-side — profit, win rate, ROI,
// breakdowns by sport/book/type, and the period rollups for the dashboard
// are all derived client-side (see src/utils/bets.ts), same "D1 holds the
// facts, the UI derives the view" split as the rest of this app (Contacts'
// household connections, the Journal's pulled-in data). At personal-bet-log
// scale there's no reason to duplicate that math on the server.
const BET_RESULTS = ['win', 'loss', 'push', 'void'];

app.get('/api/bets', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM bets ORDER BY date DESC, created_at DESC').all<Bet>();
  return c.json(results ?? []);
});

app.post('/api/bets', async (c) => {
  const body = await c.req.json<Partial<Bet>>();
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return c.json({ error: 'date (YYYY-MM-DD) is required' }, 400);
  if (!body.sport?.trim()) return c.json({ error: 'sport is required' }, 400);
  if (!body.sportsbook?.trim()) return c.json({ error: 'sportsbook is required' }, 400);
  if (!body.bet_type?.trim()) return c.json({ error: 'bet_type is required' }, 400);
  if (typeof body.odds !== 'number' || !Number.isFinite(body.odds) || body.odds === 0) return c.json({ error: 'odds must be a non-zero number (American odds, e.g. -110 or 150)' }, 400);
  if (typeof body.wager !== 'number' || !Number.isFinite(body.wager) || body.wager <= 0) return c.json({ error: 'wager must be a positive number' }, 400);
  if (!body.result || !BET_RESULTS.includes(body.result)) return c.json({ error: `result must be one of ${BET_RESULTS.join(', ')}` }, 400);

  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO bets (id, date, sport, sportsbook, bet_type, pick, odds, wager, result, manual_profit, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.date, body.sport.trim(), body.sportsbook.trim(), body.bet_type.trim(), body.pick?.trim() || null, body.odds, body.wager, body.result, body.manual_profit ?? null, body.notes?.trim() || null, ts, ts)
    .run();
  const bet = await c.env.DB.prepare('SELECT * FROM bets WHERE id = ?').bind(id).first<Bet>();
  return c.json(bet, 201);
});

app.patch('/api/bets/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<Bet>>();
  const existing = await c.env.DB.prepare('SELECT id FROM bets WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.result !== undefined && !BET_RESULTS.includes(body.result)) return c.json({ error: `result must be one of ${BET_RESULTS.join(', ')}` }, 400);
  if (body.odds !== undefined && (typeof body.odds !== 'number' || !Number.isFinite(body.odds) || body.odds === 0)) return c.json({ error: 'odds must be a non-zero number' }, 400);
  if (body.wager !== undefined && (typeof body.wager !== 'number' || !Number.isFinite(body.wager) || body.wager <= 0)) return c.json({ error: 'wager must be a positive number' }, 400);

  const fields: [string, unknown][] = [];
  const simple: (keyof Bet)[] = ['date', 'sport', 'sportsbook', 'bet_type', 'odds', 'wager', 'result'];
  for (const key of simple) {
    if (key in body) fields.push([key, (body as Record<string, unknown>)[key]]);
  }
  if ('pick' in body) fields.push(['pick', body.pick?.trim() || null]);
  if ('notes' in body) fields.push(['notes', body.notes?.trim() || null]);
  if ('manual_profit' in body) fields.push(['manual_profit', body.manual_profit ?? null]);

  if (fields.length > 0) {
    fields.push(['updated_at', now()]);
    const setClause = fields.map(([k]) => `${k} = ?`).join(', ');
    await c.env.DB.prepare(`UPDATE bets SET ${setClause} WHERE id = ?`)
      .bind(...fields.map(([, v]) => v), id)
      .run();
  }
  const bet = await c.env.DB.prepare('SELECT * FROM bets WHERE id = ?').bind(id).first<Bet>();
  return c.json(bet);
});

app.delete('/api/bets/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM bets WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ ok: true, time: now() }));

export default app;
