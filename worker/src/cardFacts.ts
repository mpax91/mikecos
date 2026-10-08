import type { Env } from './types';
import { detectFactValue, reindexEntry } from './vault';

/** Card Quick Facts (Mike, 2026-10-08) — the second Quick Facts exception
 * after the payment facts (accountPayers.ts), for every credit card
 * account. Written only where they apply, tagged Auto-Updates
 * (`vault_facts.managed_key 'card:*'`); editing one makes it Mike's own
 * fact, deleting one keeps it deleted (vault_fact_releases) — same rules
 * as the payment facts.
 *
 *   Card Type           Wallet card's network when set ("Visa Signature"),
 *                       else the template's default
 *   Credit Limit        latest statement
 *   Purchase APR        latest statement (variable rates move with prime)
 *   Cash Advance Limit  latest statement ("Cash Access Line")
 *   Expires             Wallet card (MM/YYYY) — statements never print it
 *   Rewards             what the card earns today: the MikeOS Rewards card
 *                       (fixed bonuses + rotating ones whose dates cover
 *                       today + base rate) when one is linked, else the
 *                       categories printed on the latest statement
 *   Number & CVV        "Saved in Wallet" when Wallet holds them — the
 *                       values themselves stay encrypted in Wallet
 *                       (reveal on tap), never in a plain-text Vault fact
 *
 * A card template's derive stores a CardFacts snapshot as `meta.card` in
 * the folder's meta_json; engine.derive calls syncCardFacts. The Wallet
 * card and the Rewards card are found by the last 4 digits. */

export interface CardFacts {
  last4: string | null;
  network: string | null; // template default, e.g. 'Visa Signature'
  creditLine: number | null;
  purchaseApr: number | null;
  cashLine: number | null;
  /** Earn rates printed on the latest statement, best first. */
  statementRewards: { rate: number; category: string }[];
}

export const CARD_KEYS = ['card:type', 'card:limit', 'card:apr', 'card:cash_limit', 'card:expires', 'card:rewards', 'card:secure'] as const;
export const CARD_LABELS: Record<(typeof CARD_KEYS)[number], string> = {
  'card:type': 'Card Type',
  'card:limit': 'Credit Limit',
  'card:apr': 'Purchase APR',
  'card:cash_limit': 'Cash Advance Limit',
  'card:expires': 'Expires',
  'card:rewards': 'Rewards',
  'card:secure': 'Number & CVV',
};

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pctText = (n: number) => `${n}%`;

/** "5% Amazon, Whole Foods · 2% Gas, Restaurants · 1% Everything Else". */
export function rewardsLine(rows: { rate: number; category: string }[]): string | null {
  const byRate = new Map<number, string[]>();
  for (const r of rows) {
    if (!r.category || !(r.rate > 0)) continue;
    const list = byRate.get(r.rate) ?? [];
    if (!list.includes(r.category)) list.push(r.category);
    byRate.set(r.rate, list);
  }
  if (!byRate.size) return null;
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, cats]) => `${pctText(rate)} ${cats.join(', ')}`)
    .join(' · ');
}

interface WalletCardRow {
  id: string;
  nickname: string;
  network: string | null;
  expiry_month: number | null;
  expiry_year: number | null;
  number_enc: string | null;
  cvv_enc: string | null;
  rewards_card_id: string | null;
  active: number;
}

/** The MikeOS Rewards card's earn rates as of `today` (YYYY-MM-DD). */
async function rewardsCardRates(env: Env, rewardsCardId: string | null, last4: string | null, today: string): Promise<{ rate: number; category: string }[] | null> {
  let card = rewardsCardId
    ? await env.DB.prepare('SELECT id, base_rate FROM rewards_cards WHERE id = ?').bind(rewardsCardId).first<{ id: string; base_rate: number }>()
    : null;
  if (!card && last4) {
    card = await env.DB.prepare('SELECT id, base_rate FROM rewards_cards WHERE last4 = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1').bind(last4).first<{ id: string; base_rate: number }>();
  }
  if (!card) return null;
  const { results } = await env.DB.prepare('SELECT category, rate, kind, starts_on, ends_on FROM rewards_bonuses WHERE card_id = ? ORDER BY rate DESC, sort_order')
    .bind(card.id)
    .all<{ category: string; rate: number; kind: string; starts_on: string | null; ends_on: string | null }>();
  const active = (results ?? []).filter((b) => b.kind !== 'rotating' || ((!b.starts_on || b.starts_on <= today) && (!b.ends_on || b.ends_on >= today)));
  const rows = active.map((b) => ({ rate: b.rate, category: b.category.trim() }));
  if (card.base_rate > 0) rows.push({ rate: card.base_rate, category: 'Everything Else' });
  return rows;
}

export async function syncCardFacts(env: Env, entryId: string, card: CardFacts, today: string, folderId?: string): Promise<void> {
  const entry = await env.DB.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'vault_entry'`).bind(entryId).first();
  if (!entry) return;
  const wallet = card.last4
    ? await env.DB.prepare(
        `SELECT id, nickname, network, expiry_month, expiry_year, number_enc, cvv_enc, rewards_card_id, active FROM payment_cards
          WHERE last4 = ? AND card_type != 'bank' ORDER BY active DESC, updated_at DESC LIMIT 1`
      )
        .bind(card.last4)
        .first<WalletCardRow>()
    : null;
  const rewardRows = (await rewardsCardRates(env, wallet?.rewards_card_id ?? null, card.last4, today)) ?? card.statementRewards;
  const secure = wallet && (wallet.number_enc || wallet.cvv_enc) ? `Saved in Wallet${wallet.number_enc && wallet.cvv_enc ? '' : wallet.number_enc ? ' (number only)' : ' (CVV only)'}` : null;

  const want: Record<(typeof CARD_KEYS)[number], string | null> = {
    'card:type': wallet?.network?.trim() || card.network,
    'card:limit': card.creditLine !== null ? dollars(card.creditLine) : null,
    'card:apr': card.purchaseApr !== null ? `${card.purchaseApr}% (Variable)` : null,
    'card:cash_limit': card.cashLine !== null ? dollars(card.cashLine) : null,
    'card:expires': wallet?.expiry_month && wallet.expiry_year ? `${String(wallet.expiry_month).padStart(2, '0')}/${wallet.expiry_year}` : null,
    'card:rewards': rewardsLine(rewardRows),
    'card:secure': secure,
  };

  const [{ results: existing }, { results: released }, maxPos] = await Promise.all([
    env.DB.prepare(`SELECT id, managed_key, label, value FROM vault_facts WHERE entry_id = ? AND managed_key LIKE 'card:%'`)
      .bind(entryId)
      .all<{ id: string; managed_key: string; label: string; value: string | null }>(),
    env.DB.prepare(`SELECT managed_key FROM vault_fact_releases WHERE entry_id = ?`).bind(entryId).all<{ managed_key: string }>(),
    env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM vault_facts WHERE entry_id = ?').bind(entryId).first<{ m: number }>(),
  ]);
  const byKey = new Map((existing ?? []).map((r) => [r.managed_key, r]));
  const releasedKeys = new Set((released ?? []).map((r) => r.managed_key));
  let pos = (maxPos?.m ?? -1) + 1;
  const stmts: D1PreparedStatement[] = [];
  for (const key of CARD_KEYS) {
    if (releasedKeys.has(key)) continue;
    const value = want[key];
    const cur = byKey.get(key);
    const label = CARD_LABELS[key];
    if (!value) {
      if (cur) stmts.push(env.DB.prepare('DELETE FROM vault_facts WHERE id = ?').bind(cur.id));
      continue;
    }
    const det = detectFactValue(value);
    if (!cur) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO vault_facts (id, entry_id, label, value, position, created_at, value_type, value_norm, managed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(uid(), entryId, label, value, pos++, now(), det.type, det.norm, key)
      );
    } else if (cur.value !== value || cur.label !== label) {
      stmts.push(env.DB.prepare('UPDATE vault_facts SET label = ?, value = ?, value_type = ?, value_norm = ? WHERE id = ?').bind(label, value, det.type, det.norm, cur.id));
    }
  }
  if (stmts.length) {
    await env.DB.batch(stmts);
    await reindexEntry({ env }, entryId);
  }
  if (folderId) await syncWalletLink(env, folderId, entryId, wallet, card.last4);
}

/** A "Wallet · <card> ••1234" Link child on the card account's Vault
 * entry that opens the card in Wallet (like the Finance Dashboard link).
 * Live: its title/URL follow the card; removed when the card leaves
 * Wallet. If Mike deletes it, it stays deleted — until a different Wallet
 * card takes over these last 4. Bookkeeping: folder meta `walletLink`. */
async function syncWalletLink(env: Env, folderId: string, entryId: string, wallet: WalletCardRow | null, last4: string | null): Promise<void> {
  const row = await env.DB.prepare('SELECT meta_json FROM statement_folders WHERE id = ?').bind(folderId).first<{ meta_json: string | null }>();
  let meta: Record<string, unknown> = {};
  try {
    meta = row?.meta_json ? JSON.parse(row.meta_json) : {};
  } catch {
    return; // not ours to repair
  }
  const cur = meta.walletLink as { linkId: string; cardId: string } | undefined;
  const existing = cur ? await env.DB.prepare(`SELECT id, title, content FROM entities WHERE id = ? AND type = 'link'`).bind(cur.linkId).first<{ id: string; title: string; content: string | null }>() : null;
  const ts = now();
  let next: { linkId: string; cardId: string } | undefined = cur;

  if (!wallet) {
    if (existing) await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(existing.id).run();
    next = undefined;
  } else {
    const origin = (env.ALLOWED_ORIGINS ?? 'https://mikeos.pages.dev').split(',')[0].trim();
    const url = `${origin}/wallet?tab=database&type=payment&open=${wallet.id}`;
    const title = `Wallet · ${wallet.nickname}${last4 && !wallet.nickname.includes(last4) ? ` ••${last4}` : ''}`;
    const content = JSON.stringify({ url, auto: 'live' });
    if (existing) {
      if (existing.title !== title || existing.content !== content) {
        await env.DB.prepare('UPDATE entities SET title = ?, content = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(title, content, `${title} ${url}`, ts, existing.id).run();
      }
      next = { linkId: existing.id, cardId: wallet.id };
    } else if (!cur || cur.cardId !== wallet.id) {
      const max = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM entities WHERE parent_id = ? AND type = 'link'`).bind(entryId).first<{ m: number }>();
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
         VALUES (?, 'link', ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
      )
        .bind(id, title, content, entryId, (max?.m ?? -1) + 1, ts, ts, ts, `${title} ${url}`)
        .run();
      next = { linkId: id, cardId: wallet.id };
    } // else: Mike deleted it for this same card — leave it gone
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  // Re-read so a concurrent derive's meta isn't clobbered; only walletLink changes.
  const fresh = await env.DB.prepare('SELECT meta_json FROM statement_folders WHERE id = ?').bind(folderId).first<{ meta_json: string | null }>();
  let m: Record<string, unknown> = {};
  try {
    m = fresh?.meta_json ? JSON.parse(fresh.meta_json) : {};
  } catch {
    return;
  }
  if (next) m.walletLink = next;
  else delete m.walletLink;
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(m), folderId).run();
}

/** Re-syncs the card facts of any live card account with these last 4
 * digits — after a Wallet card (network, expiry, number/CVV, Rewards link)
 * or a Rewards card changes. */
export async function syncCardFactsForLast4(env: Env, last4: string | null, today: string): Promise<void> {
  if (!last4) return;
  await syncCardFactsWhere(env, today, (card) => card.last4 === last4);
}

/** Every live card account (after a Rewards card or bonus changes). */
export async function syncAllCardFacts(env: Env, today: string): Promise<void> {
  await syncCardFactsWhere(env, today, () => true);
}

async function syncCardFactsWhere(env: Env, today: string, match: (card: CardFacts) => boolean): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id, vault_entry_id, meta_json FROM statement_folders WHERE status = 'live' AND vault_entry_id IS NOT NULL AND meta_json LIKE '%"card"%'`).all<{
    id: string;
    vault_entry_id: string;
    meta_json: string;
  }>();
  for (const r of results ?? []) {
    try {
      const card = JSON.parse(r.meta_json).card as CardFacts | undefined;
      if (card && match(card)) await syncCardFacts(env, r.vault_entry_id, card, today, r.id);
    } catch {
      // not ours to repair
    }
  }
}
