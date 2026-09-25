import { Hono } from 'hono';
import type { Env } from './types';
import { decryptField, encryptField } from './cryptoField';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Wallet Part 3 — a secure Payment Cards vault (credit + debit; see
 * migrations/0049_payment_cards.sql for the schema and the linking
 * design). Mounted at /api/payment-cards. */
export const paymentCardsRouter = new Hono<{ Bindings: Env }>();

interface PaymentCardRow {
  id: string;
  nickname: string;
  card_type: string;
  network: string | null;
  issuer: string | null;
  last4: string | null;
  name_on_card: string | null;
  expiry_month: number | null;
  expiry_year: number | null;
  number_enc: string | null;
  cvv_enc: string | null;
  billing_zip: string | null;
  color: string | null;
  cover_art_key: string | null;
  back_art_key: string | null;
  notes: string | null;
  reward_worthy: number;
  rewards_card_id: string | null;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Never includes number_enc/cvv_enc, encrypted or otherwise — the list/
// detail response only ever says whether a value is on file. The actual
// number and CVV are fetched with GET /cards/:id/reveal, on tap, nowhere
// else.
function cardJson(row: PaymentCardRow) {
  return {
    id: row.id,
    nickname: row.nickname,
    cardType: row.card_type,
    network: row.network,
    issuer: row.issuer,
    last4: row.last4,
    nameOnCard: row.name_on_card,
    expiryMonth: row.expiry_month,
    expiryYear: row.expiry_year,
    hasNumber: !!row.number_enc,
    hasCvv: !!row.cvv_enc,
    billingZip: row.billing_zip,
    color: row.color,
    coverArtKey: row.cover_art_key,
    coverArtUrl: row.cover_art_key ? `/api/files/${row.cover_art_key}` : null,
    backArtKey: row.back_art_key,
    backArtUrl: row.back_art_key ? `/api/files/${row.back_art_key}` : null,
    notes: row.notes,
    rewardWorthy: row.reward_worthy === 1,
    rewardsCardId: row.rewards_card_id,
    active: row.active === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

paymentCardsRouter.get('/cards', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM payment_cards ORDER BY sort_order ASC, nickname COLLATE NOCASE ASC').all<PaymentCardRow>();
  return c.json((results ?? []).map(cardJson));
});

// Creates (or reuses, when rewardsCardId is passed) the linked Rewards
// card for a payment card flagged reward-worthy — the whole point of the
// "go for it" ask being that entering a card once here is enough. Only
// ever called when the caller didn't already point at an existing Rewards
// card, so an already-catalogued reward card (Mike's existing ~15) is
// never duplicated — the frontend is expected to offer "link to an
// existing card" first and only fall through to creating a new one.
async function createLinkedRewardsCard(c: { env: Env }, seed: { nickname: string; network: string | null; last4: string | null }): Promise<string> {
  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1.0, NULL, 0, 1, NULL, NULL, NULL, ?, ?, ?)`
  )
    .bind(id, seed.nickname, seed.network, seed.last4, (maxPos?.m ?? -1) + 1, ts, ts)
    .run();
  return id;
}

interface RewardLinkInput {
  rewardWorthy?: boolean;
  rewardsCardId?: string | null;
}

/** Resolves what rewards_card_id a create/update should end up with, given
 * the current value and what the request asked for:
 *  - rewardWorthy: false  -> unlink (never deletes the Rewards card)
 *  - rewardWorthy: true, rewardsCardId given -> link to that existing card
 *  - rewardWorthy: true, no rewardsCardId, no existing link -> create one
 *  - rewardWorthy: true, no rewardsCardId, already linked -> keep it
 *  - rewardWorthy omitted, rewardsCardId given -> re-link without
 *    otherwise touching the flag (lets an already reward-worthy card be
 *    pointed at a different Rewards entry) */
async function resolveRewardsLink(c: { env: Env }, input: RewardLinkInput, existingRewardsCardId: string | null, seed: { nickname: string; network: string | null; last4: string | null }): Promise<string | null> {
  if (input.rewardWorthy === false) return null;
  // An explicit id means "link to this existing Rewards card" — the
  // frontend only ever sends this when Mike picked one from the "link to
  // an existing card" list, so a card he already catalogued in Rewards
  // never gets duplicated. A stale/bad id falls through to the normal
  // create-if-needed resolution below instead of silently dropping the
  // request.
  if (input.rewardsCardId) {
    const exists = await c.env.DB.prepare('SELECT id FROM rewards_cards WHERE id = ?').bind(input.rewardsCardId).first();
    if (exists) return input.rewardsCardId;
  }
  if (input.rewardWorthy === true) {
    if (existingRewardsCardId) return existingRewardsCardId;
    return createLinkedRewardsCard(c, seed);
  }
  return existingRewardsCardId;
}

paymentCardsRouter.post('/cards', async (c) => {
  const body = await c.req
    .json<{
      nickname?: string;
      cardType?: string;
      network?: string | null;
      issuer?: string | null;
      last4?: string | null;
      nameOnCard?: string | null;
      expiryMonth?: number | null;
      expiryYear?: number | null;
      number?: string | null;
      cvv?: string | null;
      billingZip?: string | null;
      color?: string | null;
      coverArtKey?: string | null;
      backArtKey?: string | null;
      notes?: string | null;
      rewardWorthy?: boolean;
      rewardsCardId?: string | null;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const nickname = body.nickname?.trim();
  if (!nickname) return c.json({ error: 'nickname is required' }, 400);
  const cardType = body.cardType === 'debit' ? 'debit' : 'credit';

  let numberEnc: string | null = null;
  let cvvEnc: string | null = null;
  try {
    if (body.number?.trim()) numberEnc = await encryptField(c.env, body.number.trim());
    if (body.cvv?.trim()) cvvEnc = await encryptField(c.env, body.cvv.trim());
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'encryption failed' }, 500);
  }

  const rewardsCardId = await resolveRewardsLink(c, body, null, { nickname, network: body.network?.trim() || null, last4: body.last4?.trim() || null });

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM payment_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO payment_cards (id, nickname, card_type, network, issuer, last4, name_on_card, expiry_month, expiry_year, number_enc, cvv_enc, billing_zip, color, cover_art_key, back_art_key, notes, reward_worthy, rewards_card_id, active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(
      id,
      nickname,
      cardType,
      body.network?.trim() || null,
      body.issuer?.trim() || null,
      body.last4?.trim() || null,
      body.nameOnCard?.trim() || null,
      body.expiryMonth ?? null,
      body.expiryYear ?? null,
      numberEnc,
      cvvEnc,
      body.billingZip?.trim() || null,
      body.color || null,
      body.coverArtKey || null,
      body.backArtKey || null,
      body.notes?.trim() || null,
      body.rewardWorthy ? 1 : 0,
      rewardsCardId,
      (maxPos?.m ?? -1) + 1,
      ts,
      ts
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM payment_cards WHERE id = ?').bind(id).first<PaymentCardRow>();
  return c.json(cardJson(row!), 201);
});

paymentCardsRouter.patch('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<
    Partial<{
      nickname: string;
      cardType: string;
      network: string | null;
      issuer: string | null;
      last4: string | null;
      nameOnCard: string | null;
      expiryMonth: number | null;
      expiryYear: number | null;
      number: string | null;
      cvv: string | null;
      billingZip: string | null;
      color: string | null;
      coverArtKey: string | null;
      backArtKey: string | null;
      notes: string | null;
      rewardWorthy: boolean;
      rewardsCardId: string | null;
      active: boolean;
      sortOrder: number;
    }>
  >();
  const existing = await c.env.DB.prepare('SELECT * FROM payment_cards WHERE id = ?').bind(id).first<PaymentCardRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

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

  if (body.nickname !== undefined) set('nickname', body.nickname.trim() || existing.nickname);
  if (body.cardType !== undefined) set('card_type', body.cardType === 'debit' ? 'debit' : 'credit');
  if (body.network !== undefined) set('network', body.network?.trim() || null);
  if (body.issuer !== undefined) set('issuer', body.issuer?.trim() || null);
  if (body.last4 !== undefined) set('last4', body.last4?.trim() || null);
  if (body.nameOnCard !== undefined) set('name_on_card', body.nameOnCard?.trim() || null);
  if (body.expiryMonth !== undefined) set('expiry_month', body.expiryMonth);
  if (body.expiryYear !== undefined) set('expiry_year', body.expiryYear);
  if (body.billingZip !== undefined) set('billing_zip', body.billingZip?.trim() || null);
  if (body.color !== undefined) set('color', body.color || null);
  if (body.coverArtKey !== undefined) set('cover_art_key', body.coverArtKey || null);
  if (body.backArtKey !== undefined) set('back_art_key', body.backArtKey || null);
  if (body.notes !== undefined) set('notes', body.notes?.trim() || null);
  if (body.active !== undefined) set('active', body.active ? 1 : 0);
  if (body.sortOrder !== undefined) set('sort_order', body.sortOrder);

  if (body.number !== undefined) {
    try {
      set('number_enc', body.number?.trim() ? await encryptField(c.env, body.number.trim()) : null);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'encryption failed' }, 500);
    }
  }
  if (body.cvv !== undefined) {
    try {
      set('cvv_enc', body.cvv?.trim() ? await encryptField(c.env, body.cvv.trim()) : null);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'encryption failed' }, 500);
    }
  }

  if (body.rewardWorthy !== undefined || body.rewardsCardId !== undefined) {
    const nextLink = await resolveRewardsLink(c, body, existing.rewards_card_id, {
      nickname: body.nickname?.trim() || existing.nickname,
      network: body.network !== undefined ? body.network?.trim() || null : existing.network,
      last4: body.last4 !== undefined ? body.last4?.trim() || null : existing.last4,
    });
    if (body.rewardWorthy !== undefined) set('reward_worthy', body.rewardWorthy ? 1 : 0);
    set('rewards_card_id', nextLink);
  }

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE payment_cards SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  const row = await c.env.DB.prepare('SELECT * FROM payment_cards WHERE id = ?').bind(id).first<PaymentCardRow>();
  return c.json(cardJson(row!));
});

// Never deletes the linked Rewards card — only the payment card's own row
// and its two R2 images. The Rewards card (and any bonus/perk rows on it)
// is only ever removed from the Rewards tab directly.
paymentCardsRouter.delete('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT cover_art_key, back_art_key FROM payment_cards WHERE id = ?')
    .bind(id)
    .first<{ cover_art_key: string | null; back_art_key: string | null }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.cover_art_key) await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  if (existing.back_art_key) await c.env.FILES.delete(existing.back_art_key).catch(() => {});
  await c.env.DB.prepare('DELETE FROM payment_cards WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

paymentCardsRouter.post('/cards/reorder', async (c) => {
  const body = await c.req.json<{ ordered_ids?: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);
  const ts = now();
  const stmts = body.ordered_ids.map((cardId, index) =>
    c.env.DB.prepare('UPDATE payment_cards SET sort_order = ?, updated_at = ? WHERE id = ?').bind(index, ts, cardId)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// The only route that ever returns a decrypted number/CVV — called on an
// explicit tap in the detail view, never as part of the list/create/
// update response.
paymentCardsRouter.get('/cards/:id/reveal', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT number_enc, cvv_enc FROM payment_cards WHERE id = ?').bind(id).first<{ number_enc: string | null; cvv_enc: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  try {
    const number = row.number_enc ? await decryptField(c.env, row.number_enc) : null;
    const cvv = row.cvv_enc ? await decryptField(c.env, row.cvv_enc) : null;
    return c.json({ number, cvv });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'decryption failed' }, 500);
  }
});
