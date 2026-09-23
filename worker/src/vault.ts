import { Hono } from 'hono';
import type { Entity, Env, VaultFactRow } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// Same walk as index.ts's own extractPlainText — kept as a small local
// copy rather than imported, so this file doesn't create a circular
// import with index.ts (which mounts this router).
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

export const vaultRouter = new Hono<{ Bindings: Env }>();

function db(c: { env: Env }) {
  return c.env.DB;
}

/** Recomputes an entry's search_text from its title, freeform note body,
 * and every quick-fact label/value it currently carries — so a Vault entry
 * is findable by account number, VIN, etc. through the same search_text
 * column every other entity type already uses. Called after any fact
 * write/delete or title/content edit. */
async function reindexEntry(c: { env: Env }, entryId: string): Promise<void> {
  const entity = await db(c).prepare('SELECT title, content FROM entities WHERE id = ?').bind(entryId).first<{ title: string; content: string | null }>();
  if (!entity) return;
  const facts = await db(c).prepare('SELECT label, value FROM vault_facts WHERE entry_id = ?').bind(entryId).all<{ label: string; value: string | null }>();
  const factText = (facts.results ?? [])
    .flatMap((f) => [f.label, f.value])
    .filter(Boolean)
    .join(' ');
  const searchText = [entity.title, extractPlainText(entity.content), factText].filter(Boolean).join(' ').trim();
  await db(c).prepare('UPDATE entities SET search_text = ? WHERE id = ?').bind(searchText || null, entryId).run();
}

// ---- Entries ----

// List — a lightweight summary per entry (no facts) for the list page; the
// detail page fetches facts separately.
vaultRouter.get('/entries', async (c) => {
  const rows = await db(c)
    .prepare(`SELECT * FROM entities WHERE type = 'vault_entry' ORDER BY pinned DESC, last_touched DESC, created_at DESC`)
    .all<Entity>();
  return c.json(rows.results ?? []);
});

vaultRouter.get('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const entity = await db(c).prepare("SELECT * FROM entities WHERE id = ? AND type = 'vault_entry'").bind(id).first<Entity>();
  if (!entity) return c.json({ error: 'not found' }, 404);
  const facts = await db(c).prepare('SELECT * FROM vault_facts WHERE entry_id = ? ORDER BY position ASC').bind(id).all<VaultFactRow>();
  return c.json({ ...entity, facts: facts.results ?? [] });
});

// Blank entry — no templates. "Add a quick fact / note / link / task" all
// happen inline on the entry itself once it exists, not as setup beforehand.
vaultRouter.post('/entries', async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }));
  const id = uid();
  const ts = now();
  const title = body.title?.trim() || 'Untitled Entry';

  await db(c)
    .prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'vault_entry', ?, NULL, NULL, 1, NULL, 0, ?, ?, ?, ?)`
    )
    .bind(id, title, ts, ts, ts, title)
    .run();

  const entity = await db(c).prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity, 201);
});

vaultRouter.patch('/entries/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; content?: string | null; pinned?: boolean }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.title !== undefined) {
    sets.push('title = ?');
    binds.push(body.title.trim() || 'Untitled Entry');
  }
  if (body.content !== undefined) {
    sets.push('content = ?');
    binds.push(body.content);
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    binds.push(body.pinned ? 1 : 0);
  }
  if (sets.length) {
    sets.push('updated_at = ?', 'last_touched = ?');
    const ts = now();
    binds.push(ts, ts, id);
    await db(c).prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    if (body.title !== undefined || body.content !== undefined) await reindexEntry(c, id);
  }
  const entity = await db(c).prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<Entity>();
  return c.json(entity);
});

vaultRouter.delete('/entries/:id', async (c) => {
  await db(c).prepare('DELETE FROM entities WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Quick facts — a flat label/value list per entry, added/edited/
// removed inline, no registry to set up first. ----

vaultRouter.post('/entries/:id/facts', async (c) => {
  const entryId = c.req.param('id');
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const label = (body.label ?? '').trim();
  if (!label) return c.json({ error: 'label is required' }, 400);
  const maxPos = await db(c).prepare('SELECT COALESCE(MAX(position), -1) as m FROM vault_facts WHERE entry_id = ?').bind(entryId).first<{ m: number }>();
  const id = uid();
  await db(c)
    .prepare('INSERT INTO vault_facts (id, entry_id, label, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, entryId, label, body.value?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  await db(c).prepare('UPDATE entities SET last_touched = ? WHERE id = ?').bind(now(), entryId).run();
  await reindexEntry(c, entryId);
  const row = await db(c).prepare('SELECT * FROM vault_facts WHERE id = ?').bind(id).first<VaultFactRow>();
  return c.json(row, 201);
});

// Reorder — same "send the whole ordered id list, position = index" shape
// as POST /api/entities/reorder, scoped to one entry's facts.
vaultRouter.post('/entries/:id/facts/reorder', async (c) => {
  const entryId = c.req.param('id');
  const body = await c.req.json<{ ordered_ids?: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);
  const stmts = body.ordered_ids.map((factId, index) =>
    db(c).prepare('UPDATE vault_facts SET position = ? WHERE id = ? AND entry_id = ?').bind(index, factId, entryId)
  );
  await db(c).batch(stmts);
  return c.json({ ok: true });
});

vaultRouter.patch('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const existing = await db(c).prepare('SELECT entry_id FROM vault_facts WHERE id = ?').bind(id).first<{ entry_id: string }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.label !== undefined) {
    const label = body.label.trim();
    if (!label) return c.json({ error: 'label cannot be empty' }, 400);
    sets.push('label = ?');
    binds.push(label);
  }
  if (body.value !== undefined) {
    sets.push('value = ?');
    binds.push(body.value?.trim() || null);
  }
  if (sets.length) {
    binds.push(id);
    await db(c).prepare(`UPDATE vault_facts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    await db(c).prepare('UPDATE entities SET last_touched = ? WHERE id = ?').bind(now(), existing.entry_id).run();
    await reindexEntry(c, existing.entry_id);
  }
  const row = await db(c).prepare('SELECT * FROM vault_facts WHERE id = ?').bind(id).first<VaultFactRow>();
  return c.json(row);
});

vaultRouter.delete('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db(c).prepare('SELECT entry_id FROM vault_facts WHERE id = ?').bind(id).first<{ entry_id: string }>();
  await db(c).prepare('DELETE FROM vault_facts WHERE id = ?').bind(id).run();
  if (existing) await reindexEntry(c, existing.entry_id);
  return c.json({ ok: true });
});

// ---- Rollup — group every quick fact across all entries by its label, so
// e.g. every "Account #" fact shows up together regardless of which entry
// it's filed on. Grouping is case/whitespace-insensitive (so "VIN" and
// "vin " land together) but not fuzzy — "Account #" and "Acct #" stay
// separate groups. Display label is whichever exact casing was used most
// often within the group. ----

vaultRouter.get('/facts/rollup', async (c) => {
  const rows = await db(c)
    .prepare(
      `SELECT vf.id as fact_id, vf.label, vf.value, vf.entry_id, e.title as entry_title, e.pinned as entry_pinned
       FROM vault_facts vf
       JOIN entities e ON e.id = vf.entry_id AND e.type = 'vault_entry'
       ORDER BY vf.label COLLATE NOCASE, e.title COLLATE NOCASE`
    )
    .all<{ fact_id: string; label: string; value: string | null; entry_id: string; entry_title: string; entry_pinned: number }>();

  type Group = {
    key: string;
    labelCounts: Map<string, number>;
    items: { fact_id: string; label: string; value: string | null; entry_id: string; entry_title: string }[];
  };
  const groups = new Map<string, Group>();

  for (const r of rows.results ?? []) {
    const key = r.label.trim().toLowerCase();
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, labelCounts: new Map(), items: [] };
      groups.set(key, g);
    }
    g.labelCounts.set(r.label, (g.labelCounts.get(r.label) ?? 0) + 1);
    g.items.push({ fact_id: r.fact_id, label: r.label, value: r.value, entry_id: r.entry_id, entry_title: r.entry_title || 'Untitled Entry' });
  }

  const result = Array.from(groups.values())
    .map((g) => {
      const displayLabel = Array.from(g.labelCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
      return {
        label: displayLabel,
        count: g.items.length,
        entries: g.items.map((i) => ({ factId: i.fact_id, entryId: i.entry_id, entryTitle: i.entry_title, value: i.value })),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return c.json(result);
});

// ---- Distinct labels + usage counts — a lightweight sibling of /rollup
// (no entries/values, just label+count) for two UI features that both
// need "which labels already exist, ranked by how often they're used":
// the ghost-text autocomplete on a blank label field (VaultFactsTable),
// and the "5+ uses" promoted-filter chips on the Rollups page. Same
// case/whitespace-insensitive-but-not-fuzzy grouping as /rollup. ----
vaultRouter.get('/facts/labels', async (c) => {
  const rows = await db(c).prepare('SELECT label FROM vault_facts').all<{ label: string }>();

  const groups = new Map<string, Map<string, number>>();
  for (const r of rows.results ?? []) {
    const key = r.label.trim().toLowerCase();
    if (!key) continue;
    let counts = groups.get(key);
    if (!counts) {
      counts = new Map();
      groups.set(key, counts);
    }
    counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  }

  const result = Array.from(groups.values())
    .map((counts) => {
      const displayLabel = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const count = Array.from(counts.values()).reduce((a, b) => a + b, 0);
      return { label: displayLabel, count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return c.json(result);
});
