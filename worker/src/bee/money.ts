import type { Env } from '../types';

/** Paid-subscription money from Stripe's balance history. Each charge's
 * Fee column bundles Substack's 10% and Stripe's card processing — split
 * here (Substack = 10% of the charge, processing = the rest; matches
 * 2.9% + $0.30 on every charge so far). Stripe Billing's 0.7% "usage fee"
 * and its tax arrive as separate stripe_fee lines the day after a charge.
 * Year = the charge's date (UTC as exported). */

export interface StripeTxn {
  id: string;
  type: string;
  source: string | null;
  amount: number;
  fee: number;
  net: number;
  created: string;
  available_on: string | null;
  description: string | null;
  transfer: string | null;
  transfer_date: string | null;
}

export interface MoneyYear {
  year: number;
  charges: number;
  newSubs: number;
  renewals: number;
  gross: number;
  substackFee: number;
  processing: number;
  billingFee: number;
  refunds: number;
  disputes: number;
  net: number;
  paidOut: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function loadStripe(env: Env): Promise<StripeTxn[]> {
  const { results } = await env.DB.prepare('SELECT * FROM bee_stripe_txns ORDER BY created').all<StripeTxn>();
  return results ?? [];
}

export function moneyByYear(txns: StripeTxn[]): MoneyYear[] {
  const years = new Map<number, MoneyYear>();
  const get = (y: number) =>
    years.get(y) ??
    (years.set(y, { year: y, charges: 0, newSubs: 0, renewals: 0, gross: 0, substackFee: 0, processing: 0, billingFee: 0, refunds: 0, disputes: 0, net: 0, paidOut: 0 }), years.get(y)!);
  for (const t of txns) {
    const y = get(Number(t.created.slice(0, 4)));
    const type = t.type.toLowerCase();
    if (type === 'charge' || type === 'payment') {
      y.charges++;
      if (/creation/i.test(t.description ?? '')) y.newSubs++;
      else y.renewals++;
      y.gross += t.amount;
      const substack = r2(t.amount * 0.1);
      y.substackFee += Math.min(substack, t.fee);
      y.processing += Math.max(0, t.fee - substack);
      y.net += t.net;
    } else if (type === 'stripe_fee' || type === 'stripe_fx_fee' || type === 'tax') {
      y.billingFee += -t.net;
      y.net += t.net;
    } else if (type === 'refund' || type === 'payment_refund') {
      y.refunds += -t.amount;
      y.net += t.net;
    } else if (type.startsWith('dispute') || type === 'adjustment') {
      y.disputes += -t.net;
      y.net += t.net;
    } else if (type === 'payout') {
      y.paidOut += -t.amount;
    }
  }
  return [...years.values()]
    .map((y) => ({ ...y, gross: r2(y.gross), substackFee: r2(y.substackFee), processing: r2(y.processing), billingFee: r2(y.billingFee), refunds: r2(y.refunds), disputes: r2(y.disputes), net: r2(y.net), paidOut: r2(y.paidOut) }))
    .sort((a, b) => a.year - b.year);
}

/** Money still sitting in Stripe (not yet paid out). */
export const stripeBalance = (txns: StripeTxn[]) => r2(txns.reduce((n, t) => n + t.net, 0));
