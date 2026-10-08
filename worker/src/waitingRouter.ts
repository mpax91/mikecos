import { Hono } from 'hono';
import type { Env } from './types';

/** Waiting For (migration 0095). A follow-up is an ordinary standalone
 * task ("Check Back: <task>", parent NULL, is_top_level 1, due N days out)
 * with waiting_source_id pointing at the task Mike handed off — so it
 * lands on Today and the Calendar with no special casing. Checking it off
 * = received; completing it pops the same toast, so "still waiting" is
 * just another follow-up. Mounted at /api/waiting. */
export const waitingRouter = new Hono<{ Bindings: Env }>();

const now = () => new Date().toISOString();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PREFIX = 'Check Back: ';

// POST /api/waiting { sourceId, days } — create the check-back task.
waitingRouter.post('/', async (c) => {
  const body = await c.req.json<{ sourceId: string; days?: number; dueDate?: string }>();
  const source = await c.env.DB.prepare(`SELECT id, title, waiting_source_id, waiting_since FROM entities WHERE id = ? AND type = 'task'`)
    .bind(body.sourceId)
    .first<{ id: string; title: string; waiting_source_id: string | null; waiting_since: string | null }>();
  if (!source) return c.json({ error: 'task not found' }, 404);
  const today = easternToday();
  const days = Math.max(1, Math.min(365, Math.round(Number(body.days ?? 7))));
  const due = body.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : addDays(today, days);
  // Following up on a follow-up keeps pointing at the original hand-off.
  const originId = source.waiting_source_id ?? source.id;
  const since = source.waiting_since ?? today;
  const base = source.title.startsWith(PREFIX) ? source.title.slice(PREFIX.length) : source.title;
  const title = `${PREFIX}${base || 'Untitled Task'}`;
  const maxPos = await c.env.DB.prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ m: number }>();
  const id = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, waiting_source_id, waiting_since)
     VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, title, (maxPos?.m ?? -1) + 1, due, ts, ts, ts, title, originId, since)
    .run();
  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();
  return c.json(entity, 201);
});

// GET /api/waiting — open follow-ups (soonest check-back first) and the
// ones received in the last 30 days.
waitingRouter.get('/', async (c) => {
  const cutoff = addDays(easternToday(), -30);
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.title, w.status, w.due_date, w.waiting_since, w.updated_at, w.waiting_source_id,
            s.title AS source_title, s.parent_id AS source_parent_id, p.title AS source_parent_title, p.type AS source_parent_type
       FROM entities w
       LEFT JOIN entities s ON s.id = w.waiting_source_id
       LEFT JOIN entities p ON p.id = s.parent_id
      WHERE w.type = 'task' AND w.waiting_source_id IS NOT NULL
        AND (w.status != 'done' OR w.updated_at >= ?)
      ORDER BY CASE WHEN w.status = 'done' THEN 1 ELSE 0 END, w.due_date ASC, w.updated_at DESC`
  )
    .bind(cutoff)
    .all<Record<string, string | null>>();
  const map = (r: Record<string, string | null>) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    dueDate: r.due_date,
    since: r.waiting_since,
    updatedAt: r.updated_at,
    sourceId: r.waiting_source_id,
    sourceTitle: r.source_title,
    sourceParentId: r.source_parent_id,
    sourceParentTitle: r.source_parent_title,
    sourceParentType: r.source_parent_type,
  });
  const all = (rows.results ?? []).map(map);
  return c.json({ open: all.filter((r) => r.status !== 'done'), received: all.filter((r) => r.status === 'done') });
});
