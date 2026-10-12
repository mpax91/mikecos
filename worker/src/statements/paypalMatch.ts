import type { Env } from '../types';
import { cents, round2 } from './common';
import { templateById } from './templates';
import type { PaypalValues } from './templates/paypal';

/** PayPal ↔ credit card matching (Mike, 2026-10-12). Card statements only
 * say "PAYPAL *ETSY" (or just "PAYPAL *2 ITEMS"); the PayPal statement has
 * the real store. A card-funded PayPal payment is matched to the card
 * charge with the same amount posted 0–5 days later (a card refund to the
 * matching credit). Rule-based, recomputed on read — nothing stored.
 * Used both ways: card dashboards show the real store, the PayPal dashboard
 * shows which card actually paid. */

/** A card line that went through PayPal ("PAYPAL *…", "PP*…"). */
export const PAYPAL_CARD_DESC = /PAYPAL|^PP ?\*/i;
const POST_LAG_DAYS = 5;

export interface PaypalCardCharge {
  date: string;
  amount: number; // + charged to the card, − returned to the card
  merchant: string;
  type: string;
  paypalId: string | null;
  /** The funding as PayPal printed it ("Visa ••0139", "Card"). */
  printed: string;
}

export interface CardTxnLite {
  folderId: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface PaypalMatch {
  card: CardTxnLite;
  charge: PaypalCardCharge;
}

export interface PaypalMatchResult {
  matches: PaypalMatch[];
  /** Card lines that look like PayPal but have no PayPal row (yet). */
  unmatchedCard: CardTxnLite[];
  /** Card-funded PayPal rows with no card line found (other cards, or
   * months the card statements don't cover). */
  unmatchedPaypal: PaypalCardCharge[];
  paypalFolderId: string | null;
  paypalMonths: Set<string>;
  paypalFirst: string | null;
  cardNames: Map<string, string>;
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Card-funded PayPal charges/returns from parsed PayPal statement values. */
export function cardChargesFrom(stmts: { values: PaypalValues }[]): PaypalCardCharge[] {
  const out: PaypalCardCharge[] = [];
  for (const st of stmts) {
    for (const r of st.values.rows) {
      if (r.cls === 'funding' || r.currency !== 'USD') continue;
      for (const f of r.funding) {
        if (f.kind !== 'card' || !f.amount) continue;
        out.push({
          date: r.date,
          amount: round2(f.amount),
          merchant: r.name || r.type,
          type: r.type,
          paypalId: r.id,
          printed: f.last4 ? `${f.label} ••${f.last4}` : f.label,
        });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Greedy match: each PayPal charge takes the closest unused card line with
 * the same amount posted 0–5 days later (refunds: −amount, card credit). */
export function matchCharges(charges: PaypalCardCharge[], cardTxns: CardTxnLite[]): { matches: PaypalMatch[]; unmatchedCard: CardTxnLite[]; unmatchedPaypal: PaypalCardCharge[] } {
  const pool = cardTxns.filter((t) => PAYPAL_CARD_DESC.test(t.description));
  const used = new Set<CardTxnLite>();
  const matches: PaypalMatch[] = [];
  const unmatchedPaypal: PaypalCardCharge[] = [];
  for (const ch of charges) {
    let best: CardTxnLite | null = null;
    let bestGap = Infinity;
    for (const t of pool) {
      if (used.has(t) || !cents(t.amount, ch.amount)) continue;
      const gap = days(ch.date, t.date);
      if (gap < -1 || gap > POST_LAG_DAYS) continue;
      if (Math.abs(gap) < bestGap) {
        best = t;
        bestGap = Math.abs(gap);
      }
    }
    if (best) {
      used.add(best);
      matches.push({ card: best, charge: ch });
    } else unmatchedPaypal.push(ch);
  }
  return { matches, unmatchedCard: pool.filter((t) => !used.has(t)), unmatchedPaypal };
}

/** Everything live: the PayPal folder's statements against every live card folder. */
export async function loadPaypalMatches(env: Env): Promise<PaypalMatchResult> {
  const { results: folders } = await env.DB.prepare(`SELECT id, template_id FROM statement_folders WHERE status = 'live'`).all<{ id: string; template_id: string | null }>();
  const paypal = (folders ?? []).find((f) => f.template_id === 'paypal') ?? null;
  const cardFolders = (folders ?? []).filter((f) => templateById(f.template_id)?.account.kind === 'card');
  const cardNames = new Map(cardFolders.map((f) => [f.id, templateById(f.template_id)!.account.nickname]));
  const empty = { matches: [], unmatchedCard: [], unmatchedPaypal: [], paypalFolderId: paypal?.id ?? null, paypalMonths: new Set<string>(), paypalFirst: null, cardNames };
  if (!paypal) return empty;
  const { results: stmtRows } = await env.DB.prepare('SELECT period_start, period_end, values_json FROM statements WHERE folder_row_id = ? ORDER BY period_end').bind(paypal.id).all<{
    period_start: string;
    period_end: string;
    values_json: string;
  }>();
  const stmts = (stmtRows ?? []).map((r) => ({ periodStart: r.period_start, periodEnd: r.period_end, values: JSON.parse(r.values_json) as PaypalValues }));
  const charges = cardChargesFrom(stmts);
  let cardTxns: CardTxnLite[] = [];
  if (cardFolders.length) {
    const ph = cardFolders.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT folder_row_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id IN (${ph}) AND (description LIKE '%PAYPAL%' OR description LIKE 'PP*%' OR description LIKE 'PP *%') ORDER BY txn_date`,
    )
      .bind(...cardFolders.map((f) => f.id))
      .all<{ folder_row_id: string; txn_date: string; description: string; kind: string; amount: number }>();
    cardTxns = (results ?? []).map((r) => ({ folderId: r.folder_row_id, date: r.txn_date, description: r.description, kind: r.kind, amount: r.amount }));
  }
  const res = matchCharges(charges, cardTxns);
  return { ...res, paypalFolderId: paypal.id, paypalMonths: new Set(stmts.map((s) => s.periodStart.slice(0, 7))), paypalFirst: stmts[0]?.periodStart ?? null, cardNames };
}

/** Per-card view for a card dashboard: the real store on each matched line
 * (keyed date|amount|description) + merchants paid through PayPal. */
export function cardPaypalView(res: PaypalMatchResult, folderId: string) {
  const mine = res.matches.filter((m) => m.card.folderId === folderId);
  const byKey: Record<string, string> = {};
  for (const m of mine) byKey[`${m.card.date}|${m.card.amount.toFixed(2)}|${m.card.description}`] = m.charge.merchant;
  const merch = new Map<string, { name: string; total: number; count: number; last: string }>();
  for (const m of mine) {
    const k = m.charge.merchant.toLowerCase();
    const cur = merch.get(k) ?? { name: m.charge.merchant, total: 0, count: 0, last: m.card.date };
    cur.total = round2(cur.total + m.card.amount);
    if (m.card.amount > 0) cur.count++;
    cur.last = m.card.date > cur.last ? m.card.date : cur.last;
    merch.set(k, cur);
  }
  const unmatched = res.unmatchedCard.filter((t) => t.folderId === folderId && t.amount > 0);
  return {
    hasPaypal: !!res.paypalFolderId,
    byKey,
    matched: mine.filter((m) => m.card.amount > 0).length,
    unmatched: unmatched.length,
    unmatchedTotal: round2(unmatched.reduce((s, t) => s + t.amount, 0)),
    merchants: [...merch.values()].filter((m) => m.count > 0).sort((a, b) => b.total - a.total),
  };
}

export const paypalKey = (t: { date: string; amount: number; description: string }) => `${t.date}|${t.amount.toFixed(2)}|${t.description}`;
