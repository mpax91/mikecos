import { Hono } from 'hono';
import type { Env } from './types';
import { decryptField, encryptField } from './cryptoField';
import { detachCard, syncAccountsForCard } from './accountPayers';
import { syncCardFactsForLast4 } from './cardFacts';

const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
import { templateById } from './statements/templates';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// Duplicates an R2 object under a fresh key, rather than pointing both
// rows at the same key — a payment card and its linked Rewards card each
// own their art independently (deleting/replacing one's cover shouldn't
// silently break the other's). Used only at the moment a Rewards card is
// first created from a reward-worthy payment card, so Mike doesn't have
// to upload the same image twice. Best-effort: any failure (object
// missing, R2 hiccup) just leaves the new card without art rather than
// blocking its creation.
async function copyR2Object(env: Env, sourceKey: string): Promise<string | null> {
  try {
    const obj = await env.FILES.get(sourceKey);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
    const newKey = `${uid()}-${sourceKey.replace(/^[^-]*-/, '') || 'cover'}`;
    await env.FILES.put(newKey, buf, { httpMetadata: { contentType } });
    return newKey;
  } catch {
    return null;
  }
}

/** Wallet Part 3 — a secure Payment Cards vault (credit + debit, and bank
 * accounts as card_type 'bank' — see 0094_bank_accounts.sql; see
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
  pin_enc: string | null;
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
  account_kind: string | null;
  routing_number: string | null;
  wire_routing_number: string | null;
  account_owners: string | null;
}

/** credit | debit | bank — anything else falls back to credit. */
const normType = (t: unknown) => (t === 'debit' ? 'debit' : t === 'bank' ? 'bank' : 'credit');
const ACCOUNT_KINDS = ['checking', 'savings', 'money_market', 'cd', 'other'];
const normKind = (k: unknown) => (typeof k === 'string' && ACCOUNT_KINDS.includes(k) ? k : null);
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '') || null;

/** A bank account's live balance, from the latest statement of any live
 * Statements folder that lists an account with the same last 4 (Ally's
 * combined statement today). Keyed by last 4. */
export interface StatementAccountLink {
  folderId: string;
  folderNickname: string;
  institution: string | null;
  kind: string | null;
  product: string | null;
  owners: string | null;
  balance: number;
  asOf: string;
  apy: number | null;
}

export async function statementAccountsByLast4(env: Env): Promise<Map<string, StatementAccountLink>> {
  const out = new Map<string, StatementAccountLink>();
  const { results } = await env.DB.prepare(
    `SELECT f.id AS folder_id, f.template_id, s.period_end, s.values_json
       FROM statement_folders f
       JOIN statements s ON s.folder_row_id = f.id
      WHERE f.status = 'live'
        AND s.period_end = (SELECT MAX(period_end) FROM statements WHERE folder_row_id = f.id)`
  ).all<{ folder_id: string; template_id: string | null; period_end: string; values_json: string }>();
  for (const r of results ?? []) {
    let values: { accounts?: { last4: string; kind?: string; product?: string | null; holders?: string | null; ownership?: string | null; ending: number; apy?: number | null }[] };
    try {
      values = JSON.parse(r.values_json);
    } catch {
      continue;
    }
    const t = templateById(r.template_id);
    for (const a of values.accounts ?? []) {
      if (!a?.last4) continue;
      out.set(a.last4, {
        folderId: r.folder_id,
        folderNickname: t?.account.nickname ?? 'Statements',
        institution: t?.account.institution ?? null,
        kind: a.kind ?? null,
        product: a.product ?? null,
        owners: a.holders ? `${a.holders}${a.ownership ? ` (${a.ownership})` : ''}` : null,
        balance: a.ending,
        asOf: r.period_end,
        apy: a.apy ?? null,
      });
    }
  }
  return out;
}

// Never includes number_enc/cvv_enc, encrypted or otherwise — the list/
// detail response only ever says whether a value is on file. The actual
// number and CVV are fetched with GET /cards/:id/reveal, on tap, nowhere
// else.
function cardJson(row: PaymentCardRow, links?: Map<string, StatementAccountLink>) {
  const link = row.card_type === 'bank' && row.last4 ? links?.get(row.last4) ?? null : null;
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
    hasPin: !!row.pin_enc,
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
    accountKind: row.account_kind,
    routingNumber: row.routing_number,
    wireRoutingNumber: row.wire_routing_number,
    accountOwners: row.account_owners,
    statementAccount: link,
  };
}

const bankLinks = async (env: Env, row: PaymentCardRow | null) => (row?.card_type === 'bank' ? statementAccountsByLast4(env) : undefined);

paymentCardsRouter.get('/cards', async (c) => {
  // Alphabetical by nickname — there's no drag-to-reorder UI wired up for
  // Payment Cards (the /cards/reorder endpoint and sort_order column exist
  // for parity with Wallet's other card lists, but nothing in the frontend
  // calls it), so sort_order was really just creation order and made the
  // list order feel arbitrary as cards got added/imported over time.
  const { results } = await c.env.DB.prepare('SELECT * FROM payment_cards ORDER BY nickname COLLATE NOCASE ASC').all<PaymentCardRow>();
  const links = (results ?? []).some((r) => r.card_type === 'bank') ? await statementAccountsByLast4(c.env) : undefined;
  return c.json((results ?? []).map((r) => cardJson(r, links)));
});

// Accounts found on live statements that aren't in Wallet yet — offered
// as one-tap "Add" prefills in Wallet → Bank Accounts.
paymentCardsRouter.get('/bank-suggestions', async (c) => {
  const links = await statementAccountsByLast4(c.env);
  const { results } = await c.env.DB.prepare(`SELECT last4 FROM payment_cards WHERE card_type = 'bank' AND last4 IS NOT NULL`).all<{ last4: string }>();
  const have = new Set((results ?? []).map((r) => r.last4));
  return c.json([...links.entries()].filter(([last4]) => !have.has(last4)).map(([last4, l]) => ({ last4, ...l })));
});

// Creates (or reuses, when rewardsCardId is passed) the linked Rewards
// card for a payment card flagged reward-worthy — the whole point of the
// "go for it" ask being that entering a card once here is enough. Only
// ever called when the caller didn't already point at an existing Rewards
// card, so an already-catalogued reward card (Mike's existing ~15) is
// never duplicated — the frontend is expected to offer "link to an
// existing card" first and only fall through to creating a new one. If
// the payment card already has cover art, it's duplicated onto the new
// Rewards card too (see copyR2Object) so Mike doesn't have to upload the
// same image twice — a one-time carryover at creation only; the two
// cards' art is independent from then on.
async function createLinkedRewardsCard(
  c: { env: Env },
  seed: { nickname: string; network: string | null; last4: string | null; coverArtKey: string | null }
): Promise<string> {
  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rewards_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  const coverArtKey = seed.coverArtKey ? await copyR2Object(c.env, seed.coverArtKey) : null;
  await c.env.DB.prepare(
    `INSERT INTO rewards_cards (id, nickname, network, last4, base_rate, annual_fee, always_carry, active, color, cover_art_key, notes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1.0, NULL, 0, 1, NULL, ?, NULL, ?, ?, ?)`
  )
    .bind(id, seed.nickname, seed.network, seed.last4, coverArtKey, (maxPos?.m ?? -1) + 1, ts, ts)
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
async function resolveRewardsLink(c: { env: Env }, input: RewardLinkInput, existingRewardsCardId: string | null, seed: { nickname: string; network: string | null; last4: string | null; coverArtKey: string | null }): Promise<string | null> {
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
      pin?: string | null;
      billingZip?: string | null;
      color?: string | null;
      coverArtKey?: string | null;
      backArtKey?: string | null;
      notes?: string | null;
      rewardWorthy?: boolean;
      rewardsCardId?: string | null;
      accountKind?: string | null;
      routingNumber?: string | null;
      wireRoutingNumber?: string | null;
      accountOwners?: string | null;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const nickname = body.nickname?.trim();
  if (!nickname) return c.json({ error: 'nickname is required' }, 400);
  const cardType = normType(body.cardType);
  if (cardType === 'bank') body.rewardWorthy = false; // bank accounts never earn card rewards

  let numberEnc: string | null = null;
  let cvvEnc: string | null = null;
  let pinEnc: string | null = null;
  try {
    if (body.number?.trim()) numberEnc = await encryptField(c.env, body.number.trim());
    if (body.cvv?.trim()) cvvEnc = await encryptField(c.env, body.cvv.trim());
    if (body.pin?.trim()) pinEnc = await encryptField(c.env, body.pin.trim());
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'encryption failed' }, 500);
  }

  const rewardsCardId = await resolveRewardsLink(c, body, null, {
    nickname,
    network: body.network?.trim() || null,
    last4: body.last4?.trim() || null,
    coverArtKey: body.coverArtKey || null,
  });

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM payment_cards').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO payment_cards (id, nickname, card_type, network, issuer, last4, name_on_card, expiry_month, expiry_year, number_enc, cvv_enc, pin_enc, billing_zip, color, cover_art_key, back_art_key, notes, reward_worthy, rewards_card_id, active, sort_order, created_at, updated_at, account_kind, routing_number, wire_routing_number, account_owners)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
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
      pinEnc,
      body.billingZip?.trim() || null,
      body.color || null,
      body.coverArtKey || null,
      body.backArtKey || null,
      body.notes?.trim() || null,
      body.rewardWorthy ? 1 : 0,
      rewardsCardId,
      (maxPos?.m ?? -1) + 1,
      ts,
      ts,
      cardType === 'bank' ? normKind(body.accountKind) : null,
      cardType === 'bank' ? digits(body.routingNumber) : null,
      cardType === 'bank' ? digits(body.wireRoutingNumber) : null,
      cardType === 'bank' ? body.accountOwners?.trim() || null : null
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM payment_cards WHERE id = ?').bind(id).first<PaymentCardRow>();
  // A card account (Statements) with these last 4 picks up Card Type / Expires / Number & CVV.
  if (row?.card_type !== 'bank') await syncCardFactsForLast4(c.env, row?.last4 ?? null, easternToday());
  return c.json(cardJson(row!, await bankLinks(c.env, row)), 201);
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
      pin: string | null;
      billingZip: string | null;
      color: string | null;
      coverArtKey: string | null;
      backArtKey: string | null;
      notes: string | null;
      rewardWorthy: boolean;
      rewardsCardId: string | null;
      active: boolean;
      sortOrder: number;
      accountKind: string | null;
      routingNumber: string | null;
      wireRoutingNumber: string | null;
      accountOwners: string | null;
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
  if (body.cardType !== undefined) set('card_type', normType(body.cardType));
  if (body.accountKind !== undefined) set('account_kind', normKind(body.accountKind));
  if (body.routingNumber !== undefined) set('routing_number', digits(body.routingNumber));
  if (body.wireRoutingNumber !== undefined) set('wire_routing_number', digits(body.wireRoutingNumber));
  if (body.accountOwners !== undefined) set('account_owners', body.accountOwners?.trim() || null);
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
  if (body.pin !== undefined) {
    try {
      set('pin_enc', body.pin?.trim() ? await encryptField(c.env, body.pin.trim()) : null);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'encryption failed' }, 500);
    }
  }

  if (body.rewardWorthy !== undefined || body.rewardsCardId !== undefined) {
    const nextLink = await resolveRewardsLink(c, body, existing.rewards_card_id, {
      nickname: body.nickname?.trim() || existing.nickname,
      network: body.network !== undefined ? body.network?.trim() || null : existing.network,
      last4: body.last4 !== undefined ? body.last4?.trim() || null : existing.last4,
      coverArtKey: body.coverArtKey !== undefined ? body.coverArtKey || null : existing.cover_art_key,
    });
    if (body.rewardWorthy !== undefined) set('reward_worthy', body.rewardWorthy ? 1 : 0);
    set('rewards_card_id', nextLink);
  }

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), id);
    await c.env.DB.prepare(`UPDATE payment_cards SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    // "Paid With" facts show the card's nickname + last 4.
    if (body.nickname !== undefined || body.last4 !== undefined) await syncAccountsForCard(c.env, id);
  }

  const row = await c.env.DB.prepare('SELECT * FROM payment_cards WHERE id = ?').bind(id).first<PaymentCardRow>();
  // Card Quick Facts on the matching card account (network, expiry, number/CVV, Rewards link).
  if (fields.length && row?.card_type !== 'bank') {
    await syncCardFactsForLast4(c.env, row?.last4 ?? null, easternToday());
    if (existing.last4 && existing.last4 !== row?.last4) await syncCardFactsForLast4(c.env, existing.last4, easternToday());
  }
  return c.json(cardJson(row!, await bankLinks(c.env, row)));
});

// Never deletes the linked Rewards card — only the payment card's own row
// and its two R2 images. The Rewards card (and any bonus/perk rows on it)
// is only ever removed from the Rewards tab directly.
paymentCardsRouter.delete('/cards/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT cover_art_key, back_art_key, last4 FROM payment_cards WHERE id = ?')
    .bind(id)
    .first<{ cover_art_key: string | null; back_art_key: string | null; last4: string | null }>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.cover_art_key) await c.env.FILES.delete(existing.cover_art_key).catch(() => {});
  if (existing.back_art_key) await c.env.FILES.delete(existing.back_art_key).catch(() => {});
  // Accounts this card paid keep their payer as text ("… (Removed From
  // Wallet)") and get flagged, rather than silently losing it.
  await detachCard(c.env, id);
  // Explicit child cleanup rather than relying on cascade — same reasoning
  // as wallet.ts's card delete and rewards.ts's card delete.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM payment_card_facts WHERE card_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM payment_cards WHERE id = ?').bind(id),
  ]);
  await syncCardFactsForLast4(c.env, existing.last4, easternToday());
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
  const row = await c.env.DB.prepare('SELECT number_enc, cvv_enc, pin_enc FROM payment_cards WHERE id = ?').bind(id).first<{ number_enc: string | null; cvv_enc: string | null; pin_enc: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  try {
    const number = row.number_enc ? await decryptField(c.env, row.number_enc) : null;
    const cvv = row.cvv_enc ? await decryptField(c.env, row.cvv_enc) : null;
    const pin = row.pin_enc ? await decryptField(c.env, row.pin_enc) : null;
    return c.json({ number, cvv, pin });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'decryption failed' }, 500);
  }
});

// ---- Details (0050_payment_card_facts.sql) — a plain label/value list per
// card, same shape as Wallet's own card facts and Vault's quick facts: no
// field registry, just "add a detail" for whatever a particular card needs
// (a phone number to report it lost, a member ID #, anything that isn't
// one of the fixed fields above). factJson emits `entry_id` (not
// `card_id`) on purpose — the frontend's existing Vault facts UI is reused
// unmodified, and it reads facts by that shape. ----

interface PaymentCardFactRow {
  id: string;
  card_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

function factJson(row: PaymentCardFactRow) {
  return { id: row.id, entry_id: row.card_id, label: row.label, value: row.value, position: row.position, created_at: row.created_at };
}

paymentCardsRouter.get('/cards/:id/facts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM payment_card_facts WHERE card_id = ? ORDER BY position ASC').bind(c.req.param('id')).all<PaymentCardFactRow>();
  return c.json((results ?? []).map(factJson));
});

paymentCardsRouter.post('/cards/:id/facts', async (c) => {
  const cardId = c.req.param('id');
  const card = await c.env.DB.prepare('SELECT id FROM payment_cards WHERE id = ?').bind(cardId).first();
  if (!card) return c.json({ error: 'card not found' }, 404);
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const label = (body.label ?? '').trim();
  if (!label) return c.json({ error: 'label is required' }, 400);
  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as m FROM payment_card_facts WHERE card_id = ?').bind(cardId).first<{ m: number }>();
  const id = uid();
  await c.env.DB.prepare('INSERT INTO payment_card_facts (id, card_id, label, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, cardId, label, body.value?.trim() || null, (maxPos?.m ?? -1) + 1, now())
    .run();
  await c.env.DB.prepare('UPDATE payment_cards SET updated_at = ? WHERE id = ?').bind(now(), cardId).run();
  const row = await c.env.DB.prepare('SELECT * FROM payment_card_facts WHERE id = ?').bind(id).first<PaymentCardFactRow>();
  return c.json(factJson(row!), 201);
});

paymentCardsRouter.post('/cards/:id/facts/reorder', async (c) => {
  const cardId = c.req.param('id');
  const body = await c.req.json<{ ordered_ids?: string[] }>();
  if (!body.ordered_ids?.length) return c.json({ error: 'ordered_ids required' }, 400);
  const stmts = body.ordered_ids.map((factId, index) =>
    c.env.DB.prepare('UPDATE payment_card_facts SET position = ? WHERE id = ? AND card_id = ?').bind(index, factId, cardId)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

paymentCardsRouter.patch('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; value?: string | null }>();
  const existing = await c.env.DB.prepare('SELECT card_id FROM payment_card_facts WHERE id = ?').bind(id).first<{ card_id: string }>();
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
    await c.env.DB.prepare(`UPDATE payment_card_facts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    await c.env.DB.prepare('UPDATE payment_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM payment_card_facts WHERE id = ?').bind(id).first<PaymentCardFactRow>();
  return c.json(factJson(row!));
});

paymentCardsRouter.delete('/facts/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT card_id FROM payment_card_facts WHERE id = ?').bind(id).first<{ card_id: string }>();
  await c.env.DB.prepare('DELETE FROM payment_card_facts WHERE id = ?').bind(id).run();
  if (existing) await c.env.DB.prepare('UPDATE payment_cards SET updated_at = ? WHERE id = ?').bind(now(), existing.card_id).run();
  return c.json({ ok: true });
});
