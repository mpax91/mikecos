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
  pinned: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

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
  }>().catch(() => ({}) as Record<string, never>);
  const name = body.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const category = body.category?.trim() || 'Other';
  const barcodeType = normalizeBarcodeType(body.barcodeType, 'code128');

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM wallet_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO wallet_cards (id, name, category, barcode_type, barcode_value, display_number, pin_code, balance, notes, color, cover_art_key, cover_art_mime, pinned, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
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
      pinned: boolean;
      sortOrder: number;
    }>
  >();
  const existing = await c.env.DB.prepare('SELECT * FROM wallet_cards WHERE id = ?').bind(id).first<WalletCardRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  // Replacing (or clearing) cover art deletes the old R2 object so orphans
  // don't accumulate — same cleanup vault.ts's entry-delete does for file
  // attachments.
  if (body.coverArtKey !== undefined && existing.cover_art_key && existing.cover_art_key !== body.coverArtKey) {
    await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
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
  const existing = await c.env.DB.prepare('SELECT cover_art_key FROM wallet_cards WHERE id = ?').bind(id).first<{ cover_art_key: string | null }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.cover_art_key) await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  await c.env.DB.prepare('DELETE FROM wallet_cards WHERE id = ?').bind(id).run();
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
