import { Hono } from 'hono';
import type { Env } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Rewards — Phase 2 (credit-card rewards optimizer). See
 * migrations/0047_rewards.sql for the schema and why it's a separate table
 * family from Wallet's Phase 1 cards. Mounted at /api/rewards. */
export const rewardsRouter = new Hono<{ Bindings: Env }>();

interface RewardsCardRow {
  id: string;
  nickname: string;
  network: string | null;
  last4: string | null;
  base_rate: number;
  annual_fee: number | null;
  always_carry: number;
  active: number;
  color: string | null;
  cover_art_key: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface RewardsBonusRow {
  id: string;
  card_id: string;
  category: string;
  rate: number;
  kind: string;
  starts_on: string | null;
  ends_on: string | null;
  keywords: string | null;
  online_only: number;
  sort_order: number;
  created_at: string;
}

interface RewardsPerkRow {
  id: string;
  card_id: string;
  label: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}

function bonusJson(row: RewardsBonusRow) {
  return {
    id: row.id,
    cardId: row.card_id,
    category: row.category,
    rate: row.rate,
    kind: row.kind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    keywords: row.keywords,
    onlineOnly: row.online_only === 1,
    sortOrder: row.sort_order,
  };
}

function perkJson(row: RewardsPerkRow) {
  return { id: row.id, cardId: row.card_id, label: row.label, description: row.description, sortOrder: row.sort_order };
}

function cardJson(row: RewardsCardRow, bonuses: RewardsBonusRow[], perks: RewardsPerkRow[]) {
  return {
    id: row.id,
    nickname: row.nickname,
    network: row.network,
    last4: row.last4,
    baseRate: row.base_rate,
    annualFee: row.annual_fee,
    alwaysCarry: row.always_carry === 1,
    active: row.active === 1,
    color: row.color,
    coverArtKey: row.cover_art_key,
    coverArtUrl: row.cover_art_key ? `/api/files/${row.cover_art_key}` : null,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bonuses: bonuses.filter((b) => b.card_id === row.id).sort((a, b) => a.sort_order - b.sort_order).map(bonusJson),
    perks: perks.filter((p) => p.card_id === row.id).sort((a, b) => a.sort_order - b.sort_order).map(perkJson),
  };
}

// GET /api/rewards/cards — every card with its bonuses/perks nested, one
// round trip. Fine at this app's scale (~15 cards, a handful of rows each)
// and matches how Wallet's own page fetches everything once and works
// client-side from there.
rewardsRouter.get('/cards', async (c) => {
  const [cards, bonuses, perks] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM rewards_cards ORDER BY sort_order ASC, nickname COLLATE NOCASE ASC').all<RewardsCardRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_bonuses').all<RewardsBonusRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_perks').all<RewardsPerkRow>(),
  ]);
  const bonusRows = bonuses.results ?? [];
  const perkRows = perks.results ?? [];
  return c.json((cards.results ?? []).map((row) => cardJson(row, bonusRows, perkRows)));
});

rewardsRouter.post('/cards', async (c) => {
  const body = await c.req
    .json<{
      nickname?: string;
      network?: string | null;
      last4?: string | null;
      baseRate?: number;
      annualFee?: number | null;
      alwaysCarry?: boolean;
      color?: string | null;
      coverArtKey?: string | null;
      notes?: string | null;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const nickname = body.nickname?.trim();
  if (!nickname) return c.json({ error: 'nickname is required' }, 400);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      nickname,
      body.network?.trim() || null,
      body.last4?.trim() || null,
      typeof body.baseRate === 'number' ? body.baseRate : 1.0,
      typeof body.annualFee === 'number' ? body.annualFee : null,
      body.alwaysCarry ? 1 : 0,
      body.color || null,
      body.coverArtKey || null,
      body.notes?.trim() || null,
      (maxPos?.m ?? -1) + 1,
      ts,
      ts
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM rewards_cards WHERE id = ?').bind(id).first<RewardsCardRow>();
  return c.json(cardJson(row!, [], []), 201);
});

rewardsRouter.patch('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<{
      nickname: string;
      network: string | null;
      last4: string | null;
      baseRate: number;
      annualFee: number | null;
      alwaysCarry: boolean;
      active: boolean;
      color: string | null;
      coverArtKey: string | null;
      notes: string | null;
      sortOrder: number;
    }>
  >();
  const existing = await c.env.DB.prepare('SELECT * FROM rewards_cards WHERE id = ?').bind(id).first<RewardsCardRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  if (body.coverArtKey !== undefined && existing.cover_art_key && existing.cover_art_key !== body.coverArtKey) {
    await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = ?`);
    values.push(v);
  };
  if (body.nickname !== undefined) set('nickname', body.nickname.trim() || existing.nickname);
  if (body.network !== undefined) set('network', body.network?.trim() || null);
  if (body.last4 !== undefined) set('last4', body.last4?.trim() || null);
  if (body.baseRate !== undefined) set('base_rate', body.baseRate);
  if (body.annualFee !== undefined) set('annual_fee', body.annualFee);
  if (body.alwaysCarry !== undefined) set('always_carry', body.alwaysCarry ? 1 : 0);
  if (body.active !== undefined) set('active', body.active ? 1 : 0);
  if (body.color !== undefined) set('color', body.color || null);
  if (body.coverArtKey !== undefined) set('cover_art_key', body.coverArtKey || null);
  if (body.notes !== undefined) set('notes', body.notes?.trim() || null);
  if (body.sortOrder !== undefined) set('sort_order', body.sortOrder);

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE rewards_cards SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const [row, bonuses, perks] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM rewards_cards WHERE id = ?').bind(id).first<RewardsCardRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_bonuses WHERE card_id = ?').bind(id).all<RewardsBonusRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_perks WHERE card_id = ?').bind(id).all<RewardsPerkRow>(),
  ]);
  return c.json(cardJson(row!, bonuses.results ?? [], perks.results ?? []));
});

// Explicit child cleanup rather than relying on `ON DELETE CASCADE` being
// enforced on this connection — same reasoning as vault.ts's DELETE
// /entries/:id (see that file's comment, and 0041's note on the 0034
// incident this precedent comes from).
rewardsRouter.delete('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT cover_art_key FROM rewards_cards WHERE id = ?').bind(id).first<{ cover_art_key: string | null }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.cover_art_key) await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM rewards_bonuses WHERE card_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM rewards_perks WHERE card_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM rewards_cards WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- Bonus categories (fixed or rotating) ----

rewardsRouter.post('/cards/:cardId/bonuses', async (c) => {
  const cardId = c.req.param('cardId');
  const card = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE id = ?').bind(cardId).first();
  if (!card) return c.json({ error: 'card not found' }, 404);
  const body = await c.req.json<{
    category?: string;
    rate?: number;
    kind?: string;
    startsOn?: string | null;
    endsOn?: string | null;
    keywords?: string | null;
    onlineOnly?: boolean;
  }>();
  const category = body.category?.trim();
  if (!category) return c.json({ error: 'category is required' }, 400);
  if (typeof body.rate !== 'number') return c.json({ error: 'rate is required' }, 400);
  const kind = body.kind === 'rotating' ? 'rotating' : 'fixed';

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_bonuses WHERE card_id = ?').bind(cardId).first<{ m: number }>();
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO rewards_bonuses (id, card_id, category, rate, kind, starts_on, ends_on, keywords, online_only, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      cardId,
      category,
      body.rate,
      kind,
      kind === 'rotating' ? body.startsOn || null : null,
      kind === 'rotating' ? body.endsOn || null : null,
      body.keywords?.trim() || null,
      body.onlineOnly ? 1 : 0,
      (maxPos?.m ?? -1) + 1,
      now()
    )
    .run();
  await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), cardId).run();

  const row = await c.env.DB.prepare('SELECT * FROM rewards_bonuses WHERE id = ?').bind(id).first<RewardsBonusRow>();
  return c.json(bonusJson(row!), 201);
});

rewardsRouter.patch('/bonuses/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM rewards_bonuses WHERE id = ?').bind(id).first<RewardsBonusRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<
    Partial<{ category: string; rate: number; kind: string; startsOn: string | null; endsOn: string | null; keywords: string | null; onlineOnly: boolean }>
  >();

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = ?`);
    values.push(v);
  };
  if (body.category !== undefined) set('category', body.category.trim() || existing.category);
  if (body.rate !== undefined) set('rate', body.rate);
  if (body.keywords !== undefined) set('keywords', body.keywords?.trim() || null);
  if (body.onlineOnly !== undefined) set('online_only', body.onlineOnly ? 1 : 0);
  const nextKind = body.kind !== undefined ? (body.kind === 'rotating' ? 'rotating' : 'fixed') : existing.kind;
  if (body.kind !== undefined) set('kind', nextKind);
  if (body.startsOn !== undefined) set('starts_on', nextKind === 'rotating' ? body.startsOn || null : null);
  if (body.endsOn !== undefined) set('ends_on', nextKind === 'rotating' ? body.endsOn || null : null);
  // Switching fixed -> rotating with no dates supplied this call, or
  // rotating -> fixed, clears the now-inapplicable date fields.
  if (body.kind !== undefined && nextKind === 'fixed') {
    set('starts_on', null);
    set('ends_on', null);
  }

  if (fields.length) {
    values.push(id);
    await c.env.DB.prepare(`UPDATE rewards_bonuses SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM rewards_bonuses WHERE id = ?').bind(id).first<RewardsBonusRow>();
  return c.json(bonusJson(row!));
});

rewardsRouter.delete('/bonuses/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT card_id FROM rewards_bonuses WHERE id = ?').bind(id).first<{ card_id: string }>();
  await c.env.DB.prepare('DELETE FROM rewards_bonuses WHERE id = ?').bind(id).run();
  if (existing) await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  return c.json({ ok: true });
});

// ---- Perks (non-cashback benefits) ----

rewardsRouter.post('/cards/:cardId/perks', async (c) => {
  const cardId = c.req.param('cardId');
  const card = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE id = ?').bind(cardId).first();
  if (!card) return c.json({ error: 'card not found' }, 404);
  const body = await c.req.json<{ label?: string; description?: string | null }>();
  const label = body.label?.trim();
  if (!label) return c.json({ error: 'label is required' }, 400);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_perks WHERE card_id = ?').bind(cardId).first<{ m: number }>();
  const id = uid();
  await c.env.DB.prepare('INSERT INTO rewards_perks (id, card_id, label, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, cardId, label, body.description?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), cardId).run();

  const row = await c.env.DB.prepare('SELECT * FROM rewards_perks WHERE id = ?').bind(id).first<RewardsPerkRow>();
  return c.json(perkJson(row!), 201);
});

rewardsRouter.patch('/perks/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM rewards_perks WHERE id = ?').bind(id).first<RewardsPerkRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<Partial<{ label: string; description: string | null }>>();

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.label !== undefined) {
    const label = body.label.trim();
    if (!label) return c.json({ error: 'label cannot be empty' }, 400);
    fields.push('label = ?');
    values.push(label);
  }
  if (body.description !== undefined) {
    fields.push('description = ?');
    values.push(body.description?.trim() || null);
  }
  if (fields.length) {
    values.push(id);
    await c.env.DB.prepare(`UPDATE rewards_perks SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM rewards_perks WHERE id = ?').bind(id).first<RewardsPerkRow>();
  return c.json(perkJson(row!));
});

rewardsRouter.delete('/perks/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT card_id FROM rewards_perks WHERE id = ?').bind(id).first<{ card_id: string }>();
  await c.env.DB.prepare('DELETE FROM rewards_perks WHERE id = ?').bind(id).run();
  if (existing) await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  return c.json({ ok: true });
});
