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
  import_key: string | null;
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
  category: string | null;
  sort_order: number;
  created_at: string;
}

interface RewardsMerchantRow {
  id: string;
  name: string;
  aliases: string | null;
  category: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface RewardsOfferRow {
  id: string;
  card_id: string;
  merchant: string;
  description: string;
  expires_on: string | null;
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
  return { id: row.id, cardId: row.card_id, label: row.label, description: row.description, category: row.category, sortOrder: row.sort_order };
}

function merchantJson(row: RewardsMerchantRow) {
  return { id: row.id, name: row.name, aliases: row.aliases, category: row.category, notes: row.notes };
}

function offerJson(row: RewardsOfferRow) {
  return { id: row.id, cardId: row.card_id, merchant: row.merchant, description: row.description, expiresOn: row.expires_on };
}

function cardJson(row: RewardsCardRow, bonuses: RewardsBonusRow[], perks: RewardsPerkRow[], offers: RewardsOfferRow[] = []) {
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
    importKey: row.import_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bonuses: bonuses.filter((b) => b.card_id === row.id).sort((a, b) => a.sort_order - b.sort_order).map(bonusJson),
    perks: perks.filter((p) => p.card_id === row.id).sort((a, b) => a.sort_order - b.sort_order).map(perkJson),
    offers: offers.filter((o) => o.card_id === row.id).map(offerJson),
  };
}

// GET /api/rewards/cards — every card with its bonuses/perks/offers
// nested, one round trip. Fine at this app's scale (~15 cards, a handful
// of rows each) and matches how Wallet's own page fetches everything once
// and works client-side from there.
rewardsRouter.get('/cards', async (c) => {
  const [cards, bonuses, perks, offers] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM rewards_cards ORDER BY sort_order ASC, nickname COLLATE NOCASE ASC').all<RewardsCardRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_bonuses').all<RewardsBonusRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_perks').all<RewardsPerkRow>(),
    c.env.DB.prepare("SELECT * FROM rewards_offers WHERE expires_on IS NULL OR expires_on >= date('now')").all<RewardsOfferRow>(),
  ]);
  const bonusRows = bonuses.results ?? [];
  const perkRows = perks.results ?? [];
  const offerRows = offers.results ?? [];
  return c.json((cards.results ?? []).map((row) => cardJson(row, bonusRows, perkRows, offerRows)));
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
      importKey?: string | null;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const nickname = body.nickname?.trim();
  if (!nickname) return c.json({ error: 'nickname is required' }, 400);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, import_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
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
      body.importKey?.trim() || null,
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
      importKey: string | null;
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
  if (body.importKey !== undefined) set('import_key', body.importKey?.trim() || null);

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE rewards_cards SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const [row, bonuses, perks, offers] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM rewards_cards WHERE id = ?').bind(id).first<RewardsCardRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_bonuses WHERE card_id = ?').bind(id).all<RewardsBonusRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_perks WHERE card_id = ?').bind(id).all<RewardsPerkRow>(),
    c.env.DB.prepare("SELECT * FROM rewards_offers WHERE card_id = ? AND (expires_on IS NULL OR expires_on >= date('now'))").bind(id).all<RewardsOfferRow>(),
  ]);
  return c.json(cardJson(row!, bonuses.results ?? [], perks.results ?? [], offers.results ?? []));
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
    c.env.DB.prepare('DELETE FROM rewards_offers WHERE card_id = ?').bind(id),
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
  const body = await c.req.json<{ label?: string; description?: string | null; category?: string | null }>();
  const label = body.label?.trim();
  if (!label) return c.json({ error: 'label is required' }, 400);

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_perks WHERE card_id = ?').bind(cardId).first<{ m: number }>();
  const id = uid();
  await c.env.DB.prepare('INSERT INTO rewards_perks (id, card_id, label, description, category, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, cardId, label, body.description?.trim() || null, body.category?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  await c.env.DB.prepare('UPDATE rewards_cards SET updated_at = ? WHERE id = ?').bind(now(), cardId).run();

  const row = await c.env.DB.prepare('SELECT * FROM rewards_perks WHERE id = ?').bind(id).first<RewardsPerkRow>();
  return c.json(perkJson(row!), 201);
});

rewardsRouter.patch('/perks/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM rewards_perks WHERE id = ?').bind(id).first<RewardsPerkRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<Partial<{ label: string; description: string | null; category: string | null }>>();

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
  if (body.category !== undefined) {
    fields.push('category = ?');
    values.push(body.category?.trim() || null);
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

// ---- Quarterly research import ----
// The research itself (current base rate, current bonus categories split
// per-merchant so online/in-person stays accurate — see the Amazon Prime
// Visa/Whole Foods discussion this replaced manual upkeep for — and the
// current quarter's rotating categories) happens outside MikeOS entirely,
// in a Claude project Mike runs once a quarter against his actual card
// list (starting from GET /api/rewards/export below). This endpoint just
// ingests that project's output and reconciles it against what's here.
//
// import_key (0057_rewards_import.sql) is the whole matching strategy: a
// card with a given import_key gets its research-derived fields
// (nickname/network/baseRate/annualFee) updated and its bonuses/perks
// fully replaced with this import's version; an import_key not yet seen
// creates a new card; anything Mike entered by hand with no import_key is
// never touched by this endpoint at all. Personal fields — last4,
// alwaysCarry, active, color, coverArtKey, notes, sortOrder — are never
// written here either, on existing or new cards, since research has no
// way to know them.

interface ImportBonus {
  category: string;
  rate: number;
  kind?: 'fixed' | 'rotating';
  startsOn?: string | null;
  endsOn?: string | null;
  keywords?: string | null;
  onlineOnly?: boolean;
}
interface ImportPerk {
  label: string;
  description?: string | null;
  category?: string | null;
}
interface ImportCard {
  importKey: string;
  nickname: string;
  network?: string | null;
  baseRate?: number;
  annualFee?: number | null;
  bonuses?: ImportBonus[];
  perks?: ImportPerk[];
}
interface ImportMerchant {
  name: string;
  aliases?: string | null;
  category: string;
  notes?: string | null;
}

// GET /api/rewards/export — the starting context for that quarterly
// project: every card already on file, keyed by import_key, with its
// current bonuses/perks, plus the whole merchant directory, so the
// research prompt can say "here's what's currently recorded" and hand
// back a diff rather than starting blind. No personal fields beyond last4
// (useful for the project to distinguish two cards from the same issuer)
// — nothing sensitive leaves the app either way, since this only ever
// gets pasted into Mike's own Claude project. Offers are deliberately
// left out — they're personalized bank-portal deals with no public page
// to research, see 0058_rewards_merchant_intelligence.sql.
rewardsRouter.get('/export', async (c) => {
  const [cards, bonuses, perks, merchants] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM rewards_cards WHERE active = 1 ORDER BY sort_order ASC, nickname COLLATE NOCASE ASC').all<RewardsCardRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_bonuses').all<RewardsBonusRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_perks').all<RewardsPerkRow>(),
    c.env.DB.prepare('SELECT * FROM rewards_merchants ORDER BY name COLLATE NOCASE ASC').all<RewardsMerchantRow>(),
  ]);
  const bonusRows = bonuses.results ?? [];
  const perkRows = perks.results ?? [];
  const out = (cards.results ?? []).map((row) => ({
    importKey: row.import_key,
    nickname: row.nickname,
    network: row.network,
    last4: row.last4,
    baseRate: row.base_rate,
    annualFee: row.annual_fee,
    bonuses: bonusRows
      .filter((b) => b.card_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((b) => ({ category: b.category, rate: b.rate, kind: b.kind, startsOn: b.starts_on, endsOn: b.ends_on, keywords: b.keywords, onlineOnly: b.online_only === 1 })),
    perks: perkRows
      .filter((p) => p.card_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => ({ label: p.label, description: p.description, category: p.category })),
  }));
  const merchantsOut = (merchants.results ?? []).map((m) => ({ name: m.name, aliases: m.aliases, category: m.category, notes: m.notes }));
  return c.json({ generatedAt: now(), cards: out, merchants: merchantsOut });
});

rewardsRouter.post('/import', async (c) => {
  const body = await c.req.json<{ cards?: ImportCard[]; merchants?: ImportMerchant[] }>().catch(() => ({}) as { cards?: ImportCard[]; merchants?: ImportMerchant[] });
  const cards = body.cards ?? [];
  const merchants = body.merchants ?? [];
  if (cards.length === 0 && merchants.length === 0) return c.json({ error: 'a cards and/or merchants array is required' }, 400);

  let created = 0;
  let updated = 0;
  let adopted = 0;
  let bonusesWritten = 0;
  let perksWritten = 0;
  let merchantsWritten = 0;
  const errors: string[] = [];
  const seenKeys: string[] = [];

  for (const [i, card] of cards.entries()) {
    const importKey = card.importKey?.trim();
    const nickname = card.nickname?.trim();
    if (!importKey || !nickname) {
      errors.push(`cards[${i}]: importKey and nickname are both required — skipped.`);
      continue;
    }
    if (!Array.isArray(card.bonuses)) {
      errors.push(`cards[${i}] (${nickname}): bonuses must be an array (can be empty) — skipped.`);
      continue;
    }
    const badBonus = card.bonuses.find((b) => !b.category?.trim() || typeof b.rate !== 'number');
    if (badBonus) {
      errors.push(`cards[${i}] (${nickname}): every bonus needs a category and a numeric rate — skipped.`);
      continue;
    }
    seenKeys.push(importKey);

    const ts = now();
    let cardId: string;
    let existing = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE import_key = ?').bind(importKey).first<{ id: string }>();

    // First-run bootstrap: no card has this importKey yet, but Mike may
    // already have entered this exact card by hand before the research
    // project existed for it — a keyless row with the same nickname. Adopt
    // it (backfill its import_key) instead of creating a duplicate; this
    // fallback only ever fires once per card, since every subsequent
    // import matches cleanly by import_key from here on.
    if (!existing) {
      existing = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE import_key IS NULL AND nickname = ? COLLATE NOCASE').bind(nickname).first<{ id: string }>();
      if (existing) adopted++;
    }

    if (existing) {
      cardId = existing.id;
      await c.env.DB.prepare('UPDATE rewards_cards SET nickname = ?, network = ?, base_rate = ?, annual_fee = ?, import_key = ?, updated_at = ? WHERE id = ?')
        .bind(nickname, card.network?.trim() || null, typeof card.baseRate === 'number' ? card.baseRate : 1.0, typeof card.annualFee === 'number' ? card.annualFee : null, importKey, ts, cardId)
        .run();
      updated++;
    } else {
      const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_cards').first<{ m: number }>();
      cardId = uid();
      await c.env.DB.prepare(
        `INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, import_key, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, 0, 1, NULL, NULL, NULL, ?, ?, ?, ?)`
      )
        .bind(cardId, nickname, card.network?.trim() || null, typeof card.baseRate === 'number' ? card.baseRate : 1.0, typeof card.annualFee === 'number' ? card.annualFee : null, (maxPos?.m ?? -1) + 1, importKey, ts, ts)
        .run();
      created++;
    }

    await c.env.DB.prepare('DELETE FROM rewards_bonuses WHERE card_id = ?').bind(cardId).run();
    for (const [bi, b] of card.bonuses.entries()) {
      const kind = b.kind === 'rotating' ? 'rotating' : 'fixed';
      await c.env.DB.prepare(
        `INSERT INTO rewards_bonuses (id, card_id, category, rate, kind, starts_on, ends_on, keywords, online_only, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(uid(), cardId, b.category.trim(), b.rate, kind, kind === 'rotating' ? b.startsOn || null : null, kind === 'rotating' ? b.endsOn || null : null, b.keywords?.trim() || null, b.onlineOnly ? 1 : 0, bi, ts)
        .run();
      bonusesWritten++;
    }

    if (Array.isArray(card.perks)) {
      await c.env.DB.prepare('DELETE FROM rewards_perks WHERE card_id = ?').bind(cardId).run();
      for (const [pi, p] of card.perks.entries()) {
        if (!p.label?.trim()) continue;
        await c.env.DB.prepare('INSERT INTO rewards_perks (id, card_id, label, description, category, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(uid(), cardId, p.label.trim(), p.description?.trim() || null, p.category?.trim() || null, pi, ts)
          .run();
        perksWritten++;
      }
    }
  }

  // Merchants upsert by name (case-insensitive) rather than a dedicated
  // key — there's no "rename" concern the way there is for a card (Mike
  // wouldn't rename "Rhoback" to something else), so the display name
  // itself is a stable enough identity.
  for (const m of merchants) {
    const name = m.name?.trim();
    const category = m.category?.trim();
    if (!name || !category) {
      errors.push(`merchants: "${m.name ?? '(unnamed)'}" needs both a name and a category — skipped.`);
      continue;
    }
    const ts = now();
    const existingMerchant = await c.env.DB.prepare('SELECT id FROM rewards_merchants WHERE name = ? COLLATE NOCASE').bind(name).first<{ id: string }>();
    if (existingMerchant) {
      await c.env.DB.prepare('UPDATE rewards_merchants SET aliases = ?, category = ?, notes = ?, updated_at = ? WHERE id = ?')
        .bind(m.aliases?.trim() || null, category, m.notes?.trim() || null, ts, existingMerchant.id)
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO rewards_merchants (id, name, aliases, category, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid(), name, m.aliases?.trim() || null, category, m.notes?.trim() || null, ts, ts)
        .run();
    }
    merchantsWritten++;
  }

  let unmatched: { nickname: string; importKey: string }[] = [];
  if (cards.length > 0) {
    const { results: allImported } = await c.env.DB.prepare('SELECT nickname, import_key FROM rewards_cards WHERE import_key IS NOT NULL').all<{ nickname: string; import_key: string }>();
    unmatched = (allImported ?? []).filter((r) => !seenKeys.includes(r.import_key)).map((r) => ({ nickname: r.nickname, importKey: r.import_key }));
  }

  return c.json({ created, updated, adopted, bonusesWritten, perksWritten, merchantsWritten, errors, unmatchedExisting: unmatched });
});

// ---- Merchants (name/alias -> category directory, 0058) ----

rewardsRouter.get('/merchants', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM rewards_merchants ORDER BY name COLLATE NOCASE ASC').all<RewardsMerchantRow>();
  return c.json((results ?? []).map(merchantJson));
});

rewardsRouter.post('/merchants', async (c) => {
  const body = await c.req.json<{ name?: string; aliases?: string | null; category?: string; notes?: string | null }>();
  const name = body.name?.trim();
  const category = body.category?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!category) return c.json({ error: 'category is required' }, 400);
  const id = uid();
  const ts = now();
  await c.env.DB.prepare('INSERT INTO rewards_merchants (id, name, aliases, category, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, body.aliases?.trim() || null, category, body.notes?.trim() || null, ts, ts)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM rewards_merchants WHERE id = ?').bind(id).first<RewardsMerchantRow>();
  return c.json(merchantJson(row!), 201);
});

rewardsRouter.patch('/merchants/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM rewards_merchants WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<Partial<{ name: string; aliases: string | null; category: string; notes: string | null }>>();

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'name cannot be empty' }, 400);
    fields.push('name = ?');
    values.push(body.name.trim());
  }
  if (body.aliases !== undefined) {
    fields.push('aliases = ?');
    values.push(body.aliases?.trim() || null);
  }
  if (body.category !== undefined) {
    if (!body.category.trim()) return c.json({ error: 'category cannot be empty' }, 400);
    fields.push('category = ?');
    values.push(body.category.trim());
  }
  if (body.notes !== undefined) {
    fields.push('notes = ?');
    values.push(body.notes?.trim() || null);
  }
  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE rewards_merchants SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM rewards_merchants WHERE id = ?').bind(id).first<RewardsMerchantRow>();
  return c.json(merchantJson(row!));
});

rewardsRouter.delete('/merchants/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM rewards_merchants WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---- Offers (manual, per-card bank-portal deals, 0058) ----

rewardsRouter.post('/cards/:cardId/offers', async (c) => {
  const cardId = c.req.param('cardId');
  const card = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE id = ?').bind(cardId).first();
  if (!card) return c.json({ error: 'card not found' }, 404);
  const body = await c.req.json<{ merchant?: string; description?: string; expiresOn?: string | null }>();
  const merchant = body.merchant?.trim();
  const description = body.description?.trim();
  if (!merchant) return c.json({ error: 'merchant is required' }, 400);
  if (!description) return c.json({ error: 'description is required' }, 400);
  const id = uid();
  await c.env.DB.prepare('INSERT INTO rewards_offers (id, card_id, merchant, description, expires_on, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, cardId, merchant, description, body.expiresOn || null, now())
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM rewards_offers WHERE id = ?').bind(id).first<RewardsOfferRow>();
  return c.json(offerJson(row!), 201);
});

rewardsRouter.delete('/offers/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM rewards_offers WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});
