import { Hono } from 'hono';
import type {
  Entity,
  Env,
  VaultCategoryRow,
  VaultEntryGroupRow,
  VaultFieldDefRow,
  VaultFieldValueRow,
  VaultGroupFieldRow,
  VaultTemplateGroupRow,
  VaultTemplateRow,
  VaultFieldGroupRow,
} from './types';

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

const FIELD_TYPES = ['text', 'number', 'date', 'currency', 'url', 'contact', 'duration', 'list'];

export const vaultRouter = new Hono<{ Bindings: Env }>();

function db(c: { env: Env }) {
  return c.env.DB;
}

/** Recomputes an entry's search_text from its title, freeform note body,
 * and every structured field value it currently carries — so Vault
 * entries are findable by account number, serial number, etc. through the
 * same search_text column every other entity type already uses. Called
 * after any field-value write. */
async function reindexEntry(c: { env: Env }, entryId: string): Promise<void> {
  const entity = await db(c).prepare('SELECT title, content FROM entities WHERE id = ?').bind(entryId).first<{ title: string; content: string | null }>();
  if (!entity) return;
  const values = await db(c)
    .prepare('SELECT value FROM vault_field_values WHERE entry_group_id IN (SELECT id FROM vault_entry_groups WHERE entry_id = ?)')
    .bind(entryId)
    .all<{ value: string | null }>();
  const valueText = (values.results ?? [])
    .map((r) => r.value)
    .filter(Boolean)
    .join(' ');
  const searchText = [entity.title, extractPlainText(entity.content), valueText].filter(Boolean).join(' ').trim();
  await db(c).prepare('UPDATE entities SET search_text = ? WHERE id = ?').bind(searchText || null, entryId).run();
}

// ---- Field definitions ----

vaultRouter.get('/field-defs', async (c) => {
  const rows = await db(c).prepare('SELECT * FROM vault_field_defs ORDER BY name ASC').all<VaultFieldDefRow>();
  return c.json(rows.results ?? []);
});

vaultRouter.post('/field-defs', async (c) => {
  const body = await c.req.json<{ name?: string; field_type?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!body.field_type || !FIELD_TYPES.includes(body.field_type)) return c.json({ error: 'invalid field_type' }, 400);
  const id = uid();
  await db(c).prepare('INSERT INTO vault_field_defs (id, name, field_type, created_at) VALUES (?, ?, ?, ?)').bind(id, name, body.field_type, now()).run();
  const row = await db(c).prepare('SELECT * FROM vault_field_defs WHERE id = ?').bind(id).first<VaultFieldDefRow>();
  return c.json(row, 201);
});

vaultRouter.patch('/field-defs/:id', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (body.name?.trim()) {
    await db(c).prepare('UPDATE vault_field_defs SET name = ? WHERE id = ?').bind(body.name.trim(), c.req.param('id')).run();
  }
  const row = await db(c).prepare('SELECT * FROM vault_field_defs WHERE id = ?').bind(c.req.param('id')).first<VaultFieldDefRow>();
  return c.json(row);
});

vaultRouter.delete('/field-defs/:id', async (c) => {
  await db(c).prepare('DELETE FROM vault_field_defs WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Field groups (each with its ordered fields inline) ----

async function groupWithFields(c: { env: Env }, groupId: string) {
  const group = await db(c).prepare('SELECT * FROM vault_field_groups WHERE id = ?').bind(groupId).first<VaultFieldGroupRow>();
  if (!group) return null;
  const fields = await db(c)
    .prepare('SELECT gf.*, fd.name as field_name, fd.field_type as field_type FROM vault_group_fields gf JOIN vault_field_defs fd ON fd.id = gf.field_def_id WHERE gf.group_id = ? ORDER BY gf.position ASC')
    .bind(groupId)
    .all<VaultGroupFieldRow & { field_name: string; field_type: string }>();
  return { ...group, fields: fields.results ?? [] };
}

vaultRouter.get('/groups', async (c) => {
  const rows = await db(c).prepare('SELECT * FROM vault_field_groups ORDER BY name ASC').all<VaultFieldGroupRow>();
  const groups = await Promise.all((rows.results ?? []).map((g) => groupWithFields(c, g.id)));
  return c.json(groups.filter(Boolean));
});

vaultRouter.post('/groups', async (c) => {
  const body = await c.req.json<{ name?: string; field_def_ids?: string[] }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = uid();
  await db(c).prepare('INSERT INTO vault_field_groups (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, now()).run();
  const fieldIds = body.field_def_ids ?? [];
  for (let i = 0; i < fieldIds.length; i++) {
    await db(c).prepare('INSERT INTO vault_group_fields (id, group_id, field_def_id, position) VALUES (?, ?, ?, ?)').bind(uid(), id, fieldIds[i], i).run();
  }
  return c.json(await groupWithFields(c, id), 201);
});

vaultRouter.patch('/groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; field_def_ids?: string[] }>();
  if (body.name?.trim()) {
    await db(c).prepare('UPDATE vault_field_groups SET name = ? WHERE id = ?').bind(body.name.trim(), id).run();
  }
  if (body.field_def_ids) {
    await db(c).prepare('DELETE FROM vault_group_fields WHERE group_id = ?').bind(id).run();
    for (let i = 0; i < body.field_def_ids.length; i++) {
      await db(c).prepare('INSERT INTO vault_group_fields (id, group_id, field_def_id, position) VALUES (?, ?, ?, ?)').bind(uid(), id, body.field_def_ids[i], i).run();
    }
  }
  return c.json(await groupWithFields(c, id));
});

vaultRouter.delete('/groups/:id', async (c) => {
  await db(c).prepare('DELETE FROM vault_field_groups WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Templates (each with its ordered groups inline) ----

async function templateWithGroups(c: { env: Env }, templateId: string) {
  const template = await db(c).prepare('SELECT * FROM vault_templates WHERE id = ?').bind(templateId).first<VaultTemplateRow>();
  if (!template) return null;
  const tgs = await db(c)
    .prepare('SELECT * FROM vault_template_groups WHERE template_id = ? ORDER BY position ASC')
    .bind(templateId)
    .all<VaultTemplateGroupRow>();
  const groups = await Promise.all((tgs.results ?? []).map((tg) => groupWithFields(c, tg.group_id)));
  return { ...template, groups: groups.filter(Boolean) };
}

vaultRouter.get('/templates', async (c) => {
  const rows = await db(c).prepare('SELECT * FROM vault_templates ORDER BY name ASC').all<VaultTemplateRow>();
  const templates = await Promise.all((rows.results ?? []).map((t) => templateWithGroups(c, t.id)));
  return c.json(templates.filter(Boolean));
});

vaultRouter.post('/templates', async (c) => {
  const body = await c.req.json<{ name?: string; starter_content?: string | null; group_ids?: string[] }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = uid();
  await db(c).prepare('INSERT INTO vault_templates (id, name, starter_content, created_at) VALUES (?, ?, ?, ?)').bind(id, name, body.starter_content ?? null, now()).run();
  const groupIds = body.group_ids ?? [];
  for (let i = 0; i < groupIds.length; i++) {
    await db(c).prepare('INSERT INTO vault_template_groups (id, template_id, group_id, position) VALUES (?, ?, ?, ?)').bind(uid(), id, groupIds[i], i).run();
  }
  return c.json(await templateWithGroups(c, id), 201);
});

vaultRouter.patch('/templates/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; starter_content?: string | null; group_ids?: string[] }>();
  if (body.name?.trim()) await db(c).prepare('UPDATE vault_templates SET name = ? WHERE id = ?').bind(body.name.trim(), id).run();
  if (body.starter_content !== undefined) await db(c).prepare('UPDATE vault_templates SET starter_content = ? WHERE id = ?').bind(body.starter_content, id).run();
  if (body.group_ids) {
    await db(c).prepare('DELETE FROM vault_template_groups WHERE template_id = ?').bind(id).run();
    for (let i = 0; i < body.group_ids.length; i++) {
      await db(c).prepare('INSERT INTO vault_template_groups (id, template_id, group_id, position) VALUES (?, ?, ?, ?)').bind(uid(), id, body.group_ids[i], i).run();
    }
  }
  return c.json(await templateWithGroups(c, id));
});

vaultRouter.delete('/templates/:id', async (c) => {
  await db(c).prepare('DELETE FROM vault_templates WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Categories (auto-categorization rules) ----

vaultRouter.get('/categories', async (c) => {
  const rows = await db(c).prepare('SELECT * FROM vault_categories ORDER BY name ASC').all<VaultCategoryRow>();
  return c.json(rows.results ?? []);
});

vaultRouter.post('/categories', async (c) => {
  const body = await c.req.json<{ name?: string; icon?: string; trigger_field_def_id?: string }>();
  const name = (body.name ?? '').trim();
  if (!name || !body.trigger_field_def_id) return c.json({ error: 'name and trigger_field_def_id are required' }, 400);
  const id = uid();
  await db(c)
    .prepare('INSERT INTO vault_categories (id, name, icon, trigger_field_def_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, body.icon?.trim() || '📁', body.trigger_field_def_id, now())
    .run();
  const row = await db(c).prepare('SELECT * FROM vault_categories WHERE id = ?').bind(id).first<VaultCategoryRow>();
  return c.json(row, 201);
});

vaultRouter.delete('/categories/:id', async (c) => {
  await db(c).prepare('DELETE FROM vault_categories WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Entries ----

async function entryGroupsWithValues(c: { env: Env }, entryId: string) {
  const groups = await db(c)
    .prepare('SELECT * FROM vault_entry_groups WHERE entry_id = ? ORDER BY position ASC')
    .bind(entryId)
    .all<VaultEntryGroupRow>();
  return Promise.all(
    (groups.results ?? []).map(async (eg) => {
      const def = await groupWithFields(c, eg.group_id);
      const values = await db(c)
        .prepare('SELECT * FROM vault_field_values WHERE entry_group_id = ? ORDER BY position ASC')
        .bind(eg.id)
        .all<VaultFieldValueRow>();
      return { ...eg, group: def, values: values.results ?? [] };
    })
  );
}

// List — a lightweight summary per entry (no field values) for the list
// page; the detail page fetches the full structured breakdown separately.
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
  const groups = await entryGroupsWithValues(c, id);
  return c.json({ ...entity, groups });
});

vaultRouter.post('/entries', async (c) => {
  const body = await c.req.json<{ title?: string; template_id?: string }>();
  const id = uid();
  const ts = now();
  let title = body.title?.trim() || 'Untitled Entry';
  let content: string | null = null;

  if (body.template_id) {
    const template = await templateWithGroups(c, body.template_id);
    if (template) {
      content = template.starter_content ?? null;
      if (!body.title?.trim()) title = template.name;
    }
  }

  await db(c)
    .prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'vault_entry', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?)`
    )
    .bind(id, title, content, ts, ts, ts, extractPlainText(content) ?? title)
    .run();

  if (body.template_id) {
    const template = await templateWithGroups(c, body.template_id);
    if (template) {
      for (let i = 0; i < template.groups.length; i++) {
        const g = template.groups[i];
        if (!g) continue;
        const entryGroupId = uid();
        await db(c)
          .prepare('INSERT INTO vault_entry_groups (id, entry_id, group_id, label, position, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
          .bind(entryGroupId, id, g.id, i, now())
          .run();
        for (let j = 0; j < g.fields.length; j++) {
          await db(c)
            .prepare('INSERT INTO vault_field_values (id, entry_group_id, field_def_id, value, position) VALUES (?, ?, ?, NULL, ?)')
            .bind(uid(), entryGroupId, g.fields[j].field_def_id, j)
            .run();
        }
      }
    }
  }

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

// ---- Entry groups (adding/removing a group instance on a specific entry) ----

vaultRouter.post('/entries/:id/groups', async (c) => {
  const entryId = c.req.param('id');
  const body = await c.req.json<{ group_id?: string; label?: string | null }>();
  if (!body.group_id) return c.json({ error: 'group_id is required' }, 400);
  const maxPos = await db(c).prepare('SELECT COALESCE(MAX(position), -1) as m FROM vault_entry_groups WHERE entry_id = ?').bind(entryId).first<{ m: number }>();
  const entryGroupId = uid();
  await db(c)
    .prepare('INSERT INTO vault_entry_groups (id, entry_id, group_id, label, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entryGroupId, entryId, body.group_id, body.label?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  const def = await groupWithFields(c, body.group_id);
  if (def) {
    for (let i = 0; i < def.fields.length; i++) {
      await db(c)
        .prepare('INSERT INTO vault_field_values (id, entry_group_id, field_def_id, value, position) VALUES (?, ?, ?, NULL, ?)')
        .bind(uid(), entryGroupId, def.fields[i].field_def_id, i)
        .run();
    }
  }
  return c.json({ ok: true, entry_group_id: entryGroupId }, 201);
});

vaultRouter.patch('/entry-groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string | null }>();
  if (body.label !== undefined) {
    await db(c).prepare('UPDATE vault_entry_groups SET label = ? WHERE id = ?').bind(body.label?.trim() || null, id).run();
  }
  return c.json({ ok: true });
});

vaultRouter.delete('/entry-groups/:id', async (c) => {
  const id = c.req.param('id');
  const row = await db(c).prepare('SELECT entry_id FROM vault_entry_groups WHERE id = ?').bind(id).first<{ entry_id: string }>();
  await db(c).prepare('DELETE FROM vault_entry_groups WHERE id = ?').bind(id).run();
  if (row) await reindexEntry(c, row.entry_id);
  return c.json({ ok: true });
});

// Bulk-upsert every field value in one group instance in a single call —
// the entry detail page saves a whole group's worth of edits at once
// rather than one round trip per field.
vaultRouter.put('/entry-groups/:id/values', async (c) => {
  const entryGroupId = c.req.param('id');
  const body = await c.req.json<{ values: { field_def_id: string; value: string | null }[] }>();
  const eg = await db(c).prepare('SELECT entry_id FROM vault_entry_groups WHERE id = ?').bind(entryGroupId).first<{ entry_id: string }>();
  if (!eg) return c.json({ error: 'not found' }, 404);

  for (let i = 0; i < body.values.length; i++) {
    const v = body.values[i];
    const existing = await db(c)
      .prepare('SELECT id FROM vault_field_values WHERE entry_group_id = ? AND field_def_id = ?')
      .bind(entryGroupId, v.field_def_id)
      .first<{ id: string }>();
    if (existing) {
      await db(c).prepare('UPDATE vault_field_values SET value = ? WHERE id = ?').bind(v.value, existing.id).run();
    } else {
      await db(c)
        .prepare('INSERT INTO vault_field_values (id, entry_group_id, field_def_id, value, position) VALUES (?, ?, ?, ?, ?)')
        .bind(uid(), entryGroupId, v.field_def_id, v.value, i)
        .run();
    }
  }
  await db(c).prepare('UPDATE entities SET last_touched = ? WHERE id = ?').bind(now(), eg.entry_id).run();
  await reindexEntry(c, eg.entry_id);
  return c.json({ ok: true });
});
