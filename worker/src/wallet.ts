import { Hono } from 'hono';
import type { Env } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const BARCODE_TYPES = ['code128', 'qr', 'upc', 'ean13', 'none'] as const;
type BarcodeType = (typeof BARCODE_TYPES)[number];
function normalizeBarcodeType(v: unknown, fallback: BarcodeType): BarcodeType {
  return (BARCODE_TYPES as readonly string[]).includes(v as string) ? (v as BarcodeType) : fallback;
}

/** Wallet — Phase 1 (loyalty/membership/pass/gift cards). See
 * migrations/0045_wallet.sql for why this is its own flat table rather than
 * an entities-based type. Mounted at /api/wallet. */
export const walletRouter = new Hono<{ Bindings: Env }>();

interface WalletCardRow {
  id: string;
  name: string;
  category: string;
  barcode_type: string;
  barcode_value: string | null;
  display_number: string | null;
  pin_code: string | null;
  balance: string | null;
  notes: string | null;
  color: string | null;
  cover_art_key: string | null;
  cover_art_mime: string | null;
  back_art_key: string | null;
  pinned: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface WalletCardFactRow {
  id: string;
  card_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

function factJson(row: WalletCardFactRow) {
  return { id: row.id, entry_id: row.card_id, label: row.label, value: row.value, position: row.position, created_at: row.created_at };
}

// "cover art" (0045) IS the card's front image — the editor now also
// offers a back image alongside it, so both are surfaced here the same way.
function cardJson(row: WalletCardRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    barcodeType: row.barcode_type,
    barcodeValue: row.barcode_value,
    displayNumber: row.display_number,
    pinCode: row.pin_code,
    balance: row.balance,
    notes: row.notes,
    color: row.color,
    coverArtKey: row.cover_art_key,
    coverArtUrl: row.cover_art_key ? `/api/files/${row.cover_art_key}` : null,
    backArtKey: row.back_art_key,
    backArtUrl: row.back_art_key ? `/api/files/${row.back_art_key}` : null,
    pinned: row.pinned === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/wallet/cards — favorites (pinned) first, then sort_order, then
// name. sort_order is drag-reordered within each of those two buckets by
// the frontend (see /cards/reorder below), same "send the whole ordered id
// list" shape as vault facts / project entities reordering.
walletRouter.get('/cards', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM wallet_cards ORDER BY pinned DESC, sort_order ASC, name COLLATE NOCASE ASC'
  ).all<WalletCardRow>();
  return c.json((results ?? []).map(cardJson));
});

walletRouter.post('/cards', async (c) => {
  const body = await c.req.json<{
    name?: string;
    category?: string;
    barcodeType?: string;
    barcodeValue?: string | null;
    displayNumber?: string | null;
    pinCode?: string | null;
    balance?: string | null;
    notes?: string | null;
    color?: string | null;
    coverArtKey?: string | null;
    coverArtMime?: string | null;
    backArtKey?: string | null;
  }>().catch(() => ({}) as Record<string, never>);
  const name = body.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const category = body.category?.trim() || 'Other';
  const barcodeType = normalizeBarcodeType(body.barcodeType, 'code128');

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM wallet_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO wallet_cards (id, name, category, barcode_type, barcode_value, display_number, pin_code, balance, notes, color, cover_art_key, cover_art_mime, back_art_key, pinned, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      category,
      barcodeType,
      body.barcodeValue?.trim() || null,
      body.displayNumber?.trim() || null,
      body.pinCode?.trim() || null,
      body.balance?.trim() || null,
      body.notes?.trim() || null,
      body.color || null,
      body.coverArtKey || null,
      body.coverArtMime || null,
      body.backArtKey || null,
      (maxPos?.m ?? -1) + 1,
      ts,
      ts
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM wallet_cards WHERE id = ?').bind(id).first<WalletCardRow>();
  return c.json(cardJson(row!), 201);
});

walletRouter.patch('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<{
      name: string;
      category: string;
      barcodeType: string;
      barcodeValue: string | null;
      displayNumber: string | null;
      pinCode: string | null;
      balance: string | null;
      notes: string | null;
      color: string | null;
      coverArtKey: string | null;
      coverArtMime: string | null;
      backArtKey: string | null;
      pinned: boolean;
      sortOrder: number;
    }>
  >();
  const existing = await c.env.DB.prepare('SELECT * FROM wallet_cards WHERE id = ?').bind(id).first<WalletCardRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  // Replacing (or clearing) either image deletes the old R2 object so
  // orphans don't accumulate — same cleanup vault.ts's entry-delete does
  // for file attachments.
  if (body.coverArtKey !== undefined && existing.cover_art_key && existing.cover_art_key !== body.coverArtKey) {
    await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  }
  if (body.backArtKey !== undefined && existing.back_art_key && existing.back_art_key !== body.backArtKey) {
    await c.env.FILES.delete(existing.back_art_key).catch(() => {});
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = ?`);
    values.push(v);
  };
  if (body.name !== undefined) set('name', body.name.trim() || existing.name);
  if (body.category !== undefined) set('category', body.category.trim() || 'Other');
  if (body.barcodeType !== undefined) set('barcode_type', normalizeBarcodeType(body.barcodeType, existing.barcode_type as BarcodeType));
  if (body.barcodeValue !== undefined) set('barcode_value', body.barcodeValue?.trim() || null);
  if (body.displayNumber !== undefined) set('display_number', body.displayNumber?.trim() || null);
  if (body.pinCode !== undefined) set('pin_code', body.pinCode?.trim() || null);
  if (body.balance !== undefined) set('balance', body.balance?.trim() || null);
  if (body.notes !== undefined) set('notes', body.notes?.trim() || null);
  if (body.color !== undefined) set('color', body.color || null);
  if (body.coverArtKey !== undefined) set('cover_art_key', body.coverArtKey || null);
  if (body.coverArtMime !== undefined) set('cover_art_mime', body.coverArtMime || null);
  if (body.backArtKey !== undefined) set('back_art_key', body.backArtKey || null);
  if (body.pinned !== undefined) set('pinned', body.pinned ? 1 : 0);
  if (body.sortOrder !== undefined) set('sort_order', body.sortOrder);

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE wallet_cards SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const row = await c.env.DB.prepare('SELECT * FROM wallet_cards WHERE id = ?').bind(id).first<WalletCardRow>();
  return c.json(cardJson(row!));
});

walletRouter.delete('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT cover_art_key, back_art_key FROM wallet_cards WHERE id = ?')
    .bind(id)
    .first<{ cover_art_key: string | null; back_art_key: string | null }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.cover_art_key) await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  if (existing.back_art_key) await c.env.FILES.delete(existing.back_art_key).catch(() => {});
  // Explicit child cleanup rather than relying on cascade — same reasoning
  // as vault.ts's entry delete and rewards.ts's card delete.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM wallet_card_facts WHERE card_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM wallet_cards WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

walletRouter.post('/cards/reorder', async (c) => {
  const body = await c.req.json<{ ordered_ids?: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);
  const ts = now();
  const stmts = body.ordered_ids.map((cardId, index) =>
    c.env.DB.prepare('UPDATE wallet_cards SET sort_order = ?, updated_at = ? WHERE id = ?').bind(index, ts, cardId)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ---- Details (0048_wallet_card_facts.sql) — a plain label/value list per
// card, same shape and same reasoning as Vault's quick facts: no field
// registry to set up first, just "add a detail" with two text boxes
// (expiration date, member ID #, whatever the card actually needs). Its
// own table rather than reusing vault_facts — see that migration's
// comment. factJson emits `entry_id` (not `card_id`) on purpose: the
// frontend's existing Vault facts UI is reused unmodified, and it reads
// facts by that shape. ----

walletRouter.get('/cards/:id/facts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM wallet_card_facts WHERE card_id = ? ORDER BY position ASC').bind(c.req.param('id')).all<WalletCardFactRow>();
  return c.json((results ?? []).map(factJson));
});

walletRouter.post('/cards/:id/facts', async (c) => {
  const cardId = c.req.param('id');
  const card = await c.env.DB.prepare('SELECT id FROM wallet_cards WHERE id = ?').bind(cardId).first();
  if (!card) return c.json({ error: 'card not found' }, 404);
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const label = (body.label ?? '').trim();
  if (!label) return c.json({ error: 'label is required' }, 400);
  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as m FROM wallet_card_facts WHERE card_id = ?').bind(cardId).first<{ m: number }>();
  const id = uid();
  await c.env.DB.prepare('INSERT INTO wallet_card_facts (id, card_id, label, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, cardId, label, body.value?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  await c.env.DB.prepare('UPDATE wallet_cards SET updated_at = ? WHERE id = ?').bind(now(), cardId).run();
  const row = await c.env.DB.prepare('SELECT * FROM wallet_card_facts WHERE id = ?').bind(id).first<WalletCardFactRow>();
  return c.json(factJson(row!), 201);
});

walletRouter.post('/cards/:id/facts/reorder', async (c) => {
  const cardId = c.req.param('id');
  const body = await c.req.json<{ ordered_ids?: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);
  const stmts = body.ordered_ids.map((factId, index) =>
    c.env.DB.prepare('UPDATE wallet_card_facts SET position = ? WHERE id = ? AND card_id = ?').bind(index, factId, cardId)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

walletRouter.patch('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const existing = await c.env.DB.prepare('SELECT card_id FROM wallet_card_facts WHERE id = ?').bind(id).first<{ card_id: string }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.label !== undefined) {
    const label = body.label.trim();
    if (!label) return c.json({ error: 'label cannot be empty' }, 400);
    fields.push('label = ?');
    values.push(label);
  }
  if (body.value !== undefined) {
    fields.push('value = ?');
    values.push(body.value?.trim() || null);
  }
  if (fields.length) {
    values.push(id);
    await c.env.DB.prepare(`UPDATE wallet_card_facts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    await c.env.DB.prepare('UPDATE wallet_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM wallet_card_facts WHERE id = ?').bind(id).first<WalletCardFactRow>();
  return c.json(factJson(row!));
});

walletRouter.delete('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT card_id FROM wallet_card_facts WHERE id = ?').bind(id).first<{ card_id: string }>();
  await c.env.DB.prepare('DELETE FROM wallet_card_facts WHERE id = ?').bind(id).run();
  if (existing) await c.env.DB.prepare('UPDATE wallet_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  return c.json({ ok: true });
});

// ---- Categories (0046_wallet_categories.sql) — a Settings-managed pick
// list, not a constraint on wallet_cards.category (see that migration for
// why). Same shape as quick_links' add/rename/reorder/delete. ----

interface WalletCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

function categoryJson(row: WalletCategoryRow) {
  return { id: row.id, name: row.name, sortOrder: row.sort_order };
}

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || uid();

walletRouter.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM wallet_categories ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all<WalletCategoryRow>();
  return c.json((results ?? []).map(categoryJson));
});

walletRouter.post('/categories', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as Record<string, never>);
  const name = body.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM wallet_categories WHERE name = ? COLLATE NOCASE').bind(name).first();
  if (existing) return c.json({ error: 'a category with that name already exists' }, 409);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM wallet_categories').first<{ m: number }>();
  let id = slugify(name);
  // Slug collision (e.g. "Gift Card" already used, someone adds "Gift  Card")
  // falls back to a random id rather than erroring — the slug is only ever
  // used as a stable key, never shown.
  if (await c.env.DB.prepare('SELECT 1 FROM wallet_categories WHERE id = ?').bind(id).first()) id = uid();

  await c.env.DB.prepare('INSERT INTO wallet_categories (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)').bind(id, name, (maxPos?.m ?? -1) + 1, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM wallet_categories WHERE id = ?').bind(id).first<WalletCategoryRow>();
  return c.json(categoryJson(row!), 201);
});

walletRouter.patch('/categories/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; sortOrder?: number }>();
  const existing = await c.env.DB.prepare('SELECT * FROM wallet_categories WHERE id = ?').bind(id).first<WalletCategoryRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: 'name cannot be empty' }, 400);
    fields.push('name = ?');
    values.push(name);
  }
  if (body.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(body.sortOrder);
  }
  if (fields.length) {
    values.push(id);
    await c.env.DB.prepare(`UPDATE wallet_categories SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM wallet_categories WHERE id = ?').bind(id).first<WalletCategoryRow>();
  return c.json(categoryJson(row!));
});

// Deleting a category never touches wallet_cards — any card already using
// this name just keeps that text (see the migration's own comment).
walletRouter.delete('/categories/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM wallet_categories WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});
