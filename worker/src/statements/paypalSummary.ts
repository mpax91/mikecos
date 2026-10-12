import { round2 } from './common';
import type { StatementCheck } from './common';
import type { PaypalClass, PaypalFunding, PaypalRow, PaypalValues } from './templates/paypal';

/** Pure summary of the PayPal statements (shared by the derive, the Finance
 * row and the dashboard). PayPal is a pass-through payment app: the money
 * story is who Mike paid / who paid him, which card or bank funded it,
 * subscriptions, withdrawals and fees — the balance is normally $0. Only
 * USD rows are summed (a couple of 2012 rows were in GBP). */

export interface PaypalStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string;
  values: PaypalValues;
  checks: StatementCheck[];
}

/** One visible activity row, flattened for the dashboard table. */
export interface PaypalActivity {
  date: string;
  cls: PaypalClass;
  type: string;
  name: string;
  currency: string;
  amount: number;
  fee: number;
  total: number;
  recurring: boolean;
  /** "Visa ••0139", "USAA Checking ••9190", "Card", "PayPal Balance", … */
  fundedBy: string[];
  id: string | null;
  statement: string; // periodEnd of the statement it's on
}

export interface PaypalPartyTotal {
  name: string;
  total: number; // purchases: spent − refunds; people: sent
  received: number; // people: received from them
  count: number;
  first: string;
  last: string;
}

export interface PaypalSubscription {
  name: string;
  amount: number; // latest charge
  first: string;
  last: string;
  count: number;
  total: number;
  active: boolean;
  /** Latest price change (≥ $1 and ≥ 5%), if any. */
  change: { from: number; to: number; date: string } | null;
}

export interface PaypalFundingTotal {
  key: string;
  label: string;
  kind: PaypalFunding['kind'];
  last4: string | null;
  total: number;
  count: number;
  first: string;
  last: string;
}

export interface PaypalYear {
  year: number;
  purchases: number;
  payments: number;
  received: number;
  refunds: number;
  withdrawn: number;
  fees: number;
  count: number;
}

export interface PaypalMonth {
  month: string; // YYYY-MM
  spent: number;
  received: number;
  count: number;
}

export interface PaypalSummary {
  asOf: string | null;
  /** Latest printed balance (0 when the newest layout prints none). */
  balance: number;
  balancePrinted: boolean;
  firstStatement: string | null;
  statements: number;
  lastActivity: string | null;
  totals: { spent: number; received: number; refunds: number; withdrawn: number; fees: number };
  last12: { spent: number; received: number; refunds: number; withdrawn: number; fees: number; count: number; from: string | null };
  years: PaypalYear[];
  months: PaypalMonth[];
  stores: PaypalPartyTotal[];
  people: PaypalPartyTotal[];
  subscriptions: PaypalSubscription[];
  funding: PaypalFundingTotal[];
  fees: { date: string; name: string; amount: number; fee: number }[];
  withdrawals: { date: string; amount: number; to: string }[];
  /** Money left sitting in PayPal at the end of the latest statement. */
  idle: { amount: number; since: string } | null;
  activity: PaypalActivity[];
}

const SPEND: PaypalClass[] = ['purchase', 'payment'];
/** Names that are companies, not people (kept out of the People list). */
const BUSINESS = /\b(Inc|LLC|Ltd|Corp|Corporation|Company|Co\.|Committee|Department|Foundation|Association|Club|PayPal)\b/i;
const IN: PaypalClass[] = ['received', 'reward'];

export function fundingLabel(f: PaypalFunding): string {
  if (f.kind === 'balance') return 'PayPal Balance';
  if (f.kind === 'reward') return f.label;
  if (f.last4) return `${f.label} ••${f.last4}`;
  return f.label === 'Card' ? 'Card (PayPal doesn’t say which)' : f.label === 'Bank Account' ? 'Bank Account' : f.label;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company)\b/g, '')
    .trim();

export function summarizePaypal(stmts: PaypalStmtRow[], today: string): PaypalSummary {
  const latest = stmts[stmts.length - 1] ?? null;
  const activity: PaypalActivity[] = [];
  for (const st of stmts) {
    for (const r of st.values.rows) {
      if (r.cls === 'funding') continue;
      activity.push({
        date: r.date,
        cls: r.cls,
        type: r.type,
        name: r.name || r.type,
        currency: r.currency,
        amount: r.amount,
        fee: r.fee,
        total: r.total,
        recurring: r.recurring,
        fundedBy: r.funding.filter((f) => f.amount !== 0 || f.kind === 'bank').map(fundingLabel),
        id: r.id,
        statement: st.periodEnd,
      });
    }
  }
  activity.sort((a, b) => a.date.localeCompare(b.date));
  const usd = activity.filter((a) => a.currency === 'USD');

  const tally = (xs: PaypalActivity[]) => ({
    spent: round2(xs.filter((a) => SPEND.includes(a.cls)).reduce((s, a) => s - a.amount, 0)),
    received: round2(xs.filter((a) => IN.includes(a.cls)).reduce((s, a) => s + a.amount, 0)),
    refunds: round2(xs.filter((a) => a.cls === 'refund' && a.amount > 0).reduce((s, a) => s + a.amount, 0)),
    withdrawn: round2(xs.filter((a) => a.cls === 'withdrawal').reduce((s, a) => s - a.total, 0)),
    fees: round2(xs.reduce((s, a) => s - a.fee, 0)),
  });
  const from12 = addDays(today, -365);
  const recent = usd.filter((a) => a.date > from12);

  // ---- Years / months ----
  const yearMap = new Map<number, PaypalYear>();
  const monthMap = new Map<string, PaypalMonth>();
  for (const a of usd) {
    const y = Number(a.date.slice(0, 4));
    const yr = yearMap.get(y) ?? { year: y, purchases: 0, payments: 0, received: 0, refunds: 0, withdrawn: 0, fees: 0, count: 0 };
    const mo = monthMap.get(a.date.slice(0, 7)) ?? { month: a.date.slice(0, 7), spent: 0, received: 0, count: 0 };
    if (a.cls === 'purchase') yr.purchases -= a.amount;
    if (a.cls === 'payment') yr.payments -= a.amount;
    if (IN.includes(a.cls)) yr.received += a.amount;
    if (a.cls === 'refund' && a.amount > 0) yr.refunds += a.amount;
    if (a.cls === 'withdrawal') yr.withdrawn -= a.total;
    yr.fees -= a.fee;
    if (SPEND.includes(a.cls)) mo.spent -= a.amount;
    if (IN.includes(a.cls)) mo.received += a.amount;
    if (SPEND.includes(a.cls) || IN.includes(a.cls)) {
      yr.count++;
      mo.count++;
    }
    yearMap.set(y, yr);
    monthMap.set(mo.month, mo);
  }
  const years = [...yearMap.values()]
    .map((y) => ({
      ...y,
      purchases: round2(y.purchases),
      payments: round2(y.payments),
      received: round2(y.received),
      refunds: round2(y.refunds),
      withdrawn: round2(y.withdrawn),
      fees: round2(y.fees),
    }))
    .sort((a, b) => a.year - b.year);
  const months = [...monthMap.values()].map((m) => ({ ...m, spent: round2(m.spent), received: round2(m.received) })).sort((a, b) => a.month.localeCompare(b.month));

  // ---- Stores and people ----
  const party = (pred: (a: PaypalActivity) => boolean, sign: (a: PaypalActivity) => { total: number; received: number }) => {
    const m = new Map<string, PaypalPartyTotal>();
    for (const a of usd.filter(pred)) {
      const k = nameKey(a.name);
      const cur = m.get(k) ?? { name: a.name, total: 0, received: 0, count: 0, first: a.date, last: a.date };
      const v = sign(a);
      cur.total += v.total;
      cur.received += v.received;
      if (a.cls !== 'refund') cur.count++;
      cur.last = a.date;
      cur.name = a.name; // latest spelling
      m.set(k, cur);
    }
    return [...m.values()].map((p) => ({ ...p, total: round2(p.total), received: round2(p.received) }));
  };
  const stores = party(
    (a) => a.cls === 'purchase' || (a.cls === 'refund' && !isPersonName(a, usd)),
    (a) => ({ total: -a.amount, received: 0 }),
  )
    .filter((p) => p.count > 0)
    .sort((a, b) => b.total - a.total);
  const people = party(
    (a) => a.name !== a.type && !BUSINESS.test(a.name) && (a.cls === 'payment' || (a.cls === 'received' && /General Payment|Mobile Payment|Payment Received|Money Received|Personal/i.test(a.type))),
    (a) => (a.amount < 0 ? { total: -a.amount, received: 0 } : { total: 0, received: a.amount }),
  ).sort((a, b) => b.total + b.received - (a.total + a.received));

  // ---- Subscriptions ----
  const latestEnd = latest?.periodEnd ?? today;
  const purchases = usd.filter((a) => a.cls === 'purchase');
  const byName = new Map<string, PaypalActivity[]>();
  for (const a of purchases) byName.set(nameKey(a.name), [...(byName.get(nameKey(a.name)) ?? []), a]);
  const subscriptions: PaypalSubscription[] = [];
  for (const xs of byName.values()) {
    const monthsSeen = new Set(xs.map((x) => x.date.slice(0, 7)));
    const flagged = xs.some((x) => x.recurring);
    if (!flagged && monthsSeen.size < 3) continue;
    if (!flagged) {
      // Not a PayPal "Subscription Payment": only call it a subscription when
      // the charges look like one — the usual price on 3+ charges and at
      // least 60% of them, and no more than about one charge a month.
      const counts = new Map<number, number>();
      for (const x of xs) counts.set(-x.amount, (counts.get(-x.amount) ?? 0) + 1);
      const mode = Math.max(...counts.values());
      if (mode < xs.length * 0.6 || mode < 3 || xs.length > monthsSeen.size + 1) continue;
      // …and on a schedule: at least two monthly (26–35 days) or yearly gaps.
      let regular = 0;
      for (let i = 1; i < xs.length; i++) {
        const gap = (Date.parse(xs[i].date) - Date.parse(xs[i - 1].date)) / 86400000;
        if ((gap >= 26 && gap <= 35) || (gap >= 358 && gap <= 372)) regular++;
      }
      if (regular < 2) continue;
    }
    const last = xs[xs.length - 1];
    let change: PaypalSubscription['change'] = null;
    for (let i = xs.length - 1; i > 0; i--) {
      const to = -xs[i].amount;
      const from = -xs[i - 1].amount;
      if (Math.abs(to - from) >= 1 && Math.abs(to - from) >= from * 0.05) {
        change = { from, to, date: xs[i].date };
        break;
      }
    }
    subscriptions.push({
      name: last.name,
      amount: -last.amount,
      first: xs[0].date,
      last: last.date,
      count: xs.length,
      total: round2(xs.reduce((s, x) => s - x.amount, 0)),
      active: last.date >= addDays(latestEnd, -40),
      change,
    });
  }
  subscriptions.sort((a, b) => Number(b.active) - Number(a.active) || b.last.localeCompare(a.last));

  // ---- Funding sources ----
  const fundMap = new Map<string, PaypalFundingTotal>();
  for (const st of stmts) {
    for (const r of st.values.rows) {
      if (!SPEND.includes(r.cls) || r.currency !== 'USD') continue;
      for (const f of r.funding) {
        if (f.amount <= 0 && f.kind !== 'balance') continue;
        const label = fundingLabel(f);
        const cur = fundMap.get(label) ?? { key: label, label, kind: f.kind, last4: f.last4, total: 0, count: 0, first: r.date, last: r.date };
        cur.total += f.kind === 'balance' ? -f.amount : f.amount;
        cur.count++;
        cur.last = r.date;
        fundMap.set(label, cur);
      }
    }
  }
  const funding = [...fundMap.values()].map((f) => ({ ...f, total: round2(f.total) })).sort((a, b) => b.last.localeCompare(a.last) || b.total - a.total);

  const fees = usd.filter((a) => a.fee !== 0).map((a) => ({ date: a.date, name: a.name, amount: a.amount, fee: -a.fee }));
  const withdrawals = usd.filter((a) => a.cls === 'withdrawal').map((a) => ({ date: a.date, amount: -a.total, to: a.fundedBy.find((x) => !/Balance/.test(x)) ?? 'Bank' }));

  const printed = [...stmts].reverse().find((s) => s.values.ending !== null);
  const balance = latest && latest.values.ending !== null ? latest.values.ending : 0;
  const idle = latest && latest.values.ending !== null && latest.values.ending >= 1 ? { amount: latest.values.ending, since: latest.periodEnd } : null;

  return {
    asOf: latest?.periodEnd ?? null,
    balance,
    balancePrinted: !!printed && printed === latest,
    firstStatement: stmts[0]?.periodEnd ?? null,
    statements: stmts.length,
    lastActivity: activity.length ? activity[activity.length - 1].date : null,
    totals: tally(usd),
    last12: { ...tally(recent), count: recent.filter((a) => SPEND.includes(a.cls) || IN.includes(a.cls)).length, from: from12 },
    years,
    months,
    stores,
    people,
    subscriptions,
    funding,
    fees,
    withdrawals,
    idle,
    activity,
  };
}

/** A refund from someone Mike paid as a person (e.g. "Payment Refund:
 * Bruce Bennett") belongs with people, not stores. */
function isPersonName(a: PaypalActivity, all: PaypalActivity[]): boolean {
  const k = nameKey(a.name);
  return all.some((x) => (x.cls === 'payment' || x.cls === 'received') && nameKey(x.name) === k);
}
