import { round2 } from './common';
import type { StatementCheck } from './common';
import type { LowesCardValues, LowesPromo } from './templates/lowesCard';
import { addMonths } from './adtSummary';

/** Pure summary of the Lowe's credit card statements (shared by the derive,
 * the Finance row and the dashboard). Money owed is positive.
 *
 * Mike only keeps a statement for a cycle with purchases; the payment-only
 * statement Synchrony sends the next month isn't saved. So a statement's
 * payment is proven by, in order:
 *   1. checking — a Synchrony / Lowe's payment for exactly the balance in a
 *      live USAA Checking folder, between the closing date and 20 days after
 *      the due date (gives the date, so on-time is known);
 *   2. statement — the next cycle was also kept and shows the payment;
 *   3. next_zero — a later kept statement opens at $0 (paid in full). On time
 *      when that statement's year-to-date fees show no fee beyond the ones on
 *      kept statements (same calendar year only — otherwise unknown).
 * A later statement that opens with a balance = carried. The latest
 * statement with nothing proving it = 'due' until the due date, then
 * 'unconfirmed'.
 *
 * Savings: the 5% comes off at checkout (not on tax or shipping) and the
 * statement never prints it — estimated as charged × 5/95 ÷ (1 + sales tax). */

export const LOWES_DISCOUNT = 0.05;
export const LOWES_SALES_TAX = 0.08375; // Westchester County, NY
export const LOWES_COMPARE_RATE = 0.02; // a plain 2% cash-back card
const SAVINGS_FACTOR = LOWES_DISCOUNT / (1 - LOWES_DISCOUNT) / (1 + LOWES_SALES_TAX);
const PAY_WINDOW_DAYS = 20;
export const DORMANT_MONTHS = 12;

export interface LowesCardStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string;
  values: LowesCardValues;
  checks: StatementCheck[];
}

export interface LowesCardTxnRow {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

/** A payment out of checking (USAA statements, amount negative). */
export interface CheckingPayment {
  date: string;
  description: string;
  amount: number;
  account: string; // "USAA Checking"
}

export type LowesPayStatus = 'none_due' | 'checking' | 'statement' | 'next_zero' | 'carried' | 'due' | 'unconfirmed';

export interface LowesPayment {
  status: LowesPayStatus;
  date: string | null;
  amount: number | null;
  onTime: boolean | null;
  source: string | null; // "USAA Checking", "Jul 2024 statement", …
}

export interface LowesItemLine {
  date: string;
  amount: number;
  where: string; // "Lowes.com" | "Yorktown NY (#3360)" | "In store"
  online: boolean;
  items: string[];
  category: string;
  shipped: boolean;
  estSavings: number;
  statementClosing: string;
}

export interface LowesCardStatementRow {
  closingDate: string;
  openingDate: string;
  previousBalance: number;
  paid: number;
  refunds: number;
  purchases: number;
  online: number;
  inStore: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  apr: number | null;
  termsNotice: boolean;
  noticeApr: number | null;
  purchaseCount: number;
  estSavings: number;
  promos: LowesPromo[];
  payment: LowesPayment;
  fileId: string;
  checksOk: boolean;
}

export interface LowesCardYear {
  year: number;
  statements: number;
  purchases: number;
  refunds: number;
  net: number;
  online: number;
  inStore: number;
  estSavings: number;
  vsFlat: number; // estimated savings − what a 2% card would have paid
  fees: number; // kept statements + any only seen in the printed YTD
  interest: number;
  hiddenFees: number; // in the YTD, on a statement not in Drive
  hiddenInterest: number;
}

export interface LowesCardChange {
  date: string;
  what: 'apr' | 'credit_line' | 'terms';
  from: string;
  to: string;
}

export interface LowesCardSummary {
  asOf: string | null;
  latest: LowesCardStatementRow | null;
  status: 'paid' | 'due' | 'unconfirmed' | 'credit' | 'none';
  balance: number;
  /** What's still owed as far as MikeOS can tell (0 once a payment is proven). */
  owedNow: number;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null;
  purchaseApr: number | null;
  accountLast: string | null;
  firstStatement: string | null;
  firstPurchase: string | null;
  lastPurchase: string | null;
  monthsSinceUse: number | null;
  longestIdle: { from: string; to: string; months: number } | null;
  dormant: boolean;
  purchaseCount: number;
  lifetimeNet: number;
  lifetimePurchases: number;
  last12Net: number;
  ytdNet: number;
  avgPurchase: number | null;
  onlineShare: number | null;
  estSavings: number;
  estSavingsYtd: number;
  vsFlat: number;
  totalFees: number;
  totalInterest: number;
  hiddenFees: number;
  hiddenInterest: number;
  paidInFullCount: number; // statements with a balance proven paid in full
  unprovenCount: number;
  carriedStatements: string[];
  promos: LowesPromo[]; // on the latest statement
  categories: { category: string; amount: number; count: number }[];
  items: LowesItemLine[];
  changes: LowesCardChange[];
  statements: LowesCardStatementRow[];
  years: LowesCardYear[];
  nextDue: { date: string; amount: number; minimum: number } | null;
  checkingLinked: boolean;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) - (Number(b.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0);
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const estSavingsOn = (charged: number) => round2(Math.max(0, charged) * SAVINGS_FACTOR);

/** Payments out of checking that went to Synchrony / Lowe's. */
export const isSynchronyPayment = (desc: string) => /LOWES|LOWE'S|SYF|SYNCHRONY|SYNCB/i.test(desc);

const CATEGORIES: [RegExp, string][] = [
  [/WEED|GRASS|LAWN|HOSE|BLOWER|CHAINSAW|MOWER|TRIMMER|GARDEN|MULCH|SOIL|FERTIL|SEED|PLANT|PATIO|GRILL/i, 'Lawn & Garden'],
  [/GYPSUM|DRYWALL|LATTICE|SHEATHING|PLYWOOD|STUD|LUMBER|BOARD|FOAM|INSULATION|CONCRETE|ROOF|SIDING|DECK|FENCE/i, 'Building Materials'],
  [/DRILL|DRIVER|BATTER|CHARGER|SAW|TOOL|WRENCH|SANDER|LADDER/i, 'Tools'],
  [/VACUUM|PLUG-IN|OIL|CLEAN|AIR FRESH|FILTER/i, 'Cleaning & Home'],
  [/PAINT|STAIN|PRIMER|BRUSH|ROLLER/i, 'Paint'],
  [/LIGHT|BULB|ELECTRIC|OUTLET|SWITCH|WIRE/i, 'Electrical & Lighting'],
  [/FAUCET|TOILET|PLUMB|PIPE|WATER HEATER|SINK/i, 'Plumbing'],
  [/APPLIANCE|WASHER|DRYER|REFRIGERATOR|DISHWASHER|RANGE|MICROWAVE/i, 'Appliances'],
];
export function lowesCategory(items: string[]): string {
  const text = items.join(' ');
  for (const [re, name] of CATEGORIES) if (re.test(text)) return name;
  return 'Other';
}

export function summarizeLowesCard(stmts: LowesCardStmtRow[], txns: LowesCardTxnRow[], checking: CheckingPayment[] | null, today: string): LowesCardSummary {
  const lowesPays = (checking ?? []).filter((p) => p.amount < 0 && isSynchronyPayment(p.description));
  const usedChecking = new Set<CheckingPayment>();

  // Fees seen on kept statements per year, to spot ones only in the printed YTD.
  const keptFeesBefore = (year: number, upTo: string) =>
    round2(stmts.filter((x) => x.values.closingDate.startsWith(String(year)) && x.values.closingDate <= upTo).reduce((s, x) => s + x.values.fees, 0));

  const rows: LowesCardStatementRow[] = stmts.map((s, i) => {
    const v = s.values;
    const next = stmts[i + 1]?.values ?? null;
    const owed = round2(Math.max(0, v.newBalance));
    let payment: LowesPayment = { status: 'none_due', date: null, amount: null, onTime: null, source: null };
    if (owed >= 0.005) {
      // 1. Checking: exact amount, closing → due + 20 days.
      const until = addDays(v.dueDate ?? addDays(v.closingDate, 23), PAY_WINDOW_DAYS);
      const hit = lowesPays.find((p) => !usedChecking.has(p) && p.date > v.closingDate && p.date <= until && Math.abs(-p.amount - owed) < 0.005);
      const backToBack = next && Math.round((Date.parse(`${next.openingDate}T12:00:00Z`) - Date.parse(`${v.closingDate}T12:00:00Z`)) / 86400000) <= 3;
      if (hit) {
        usedChecking.add(hit);
        payment = { status: 'checking', date: hit.date, amount: owed, onTime: v.dueDate ? hit.date <= v.dueDate : null, source: hit.account };
      } else if (next && backToBack) {
        const pays = txns.filter((t) => t.statementId === stmts[i + 1].id && t.kind === 'payment');
        const carried = round2(next.previousBalance - next.paid - next.refunds);
        const first = pays[0] ?? null;
        payment =
          carried > 0.005
            ? { status: 'carried', date: first?.date ?? null, amount: next.paid || null, onTime: false, source: `${shortMonth(next.closingDate)} statement` }
            : { status: 'statement', date: first?.date ?? null, amount: next.paid, onTime: v.dueDate && first ? pays.some((p) => p.date <= addDays(v.dueDate!, 1)) : null, source: `${shortMonth(next.closingDate)} statement` };
      } else if (next) {
        if (next.previousBalance > 0.005) {
          payment = { status: 'carried', date: null, amount: null, onTime: false, source: `${shortMonth(next.closingDate)} statement opens at $${next.previousBalance.toFixed(2)}` };
        } else {
          const sameYear = next.ytdYear !== null && v.dueDate !== null && String(next.ytdYear) === v.dueDate.slice(0, 4) && next.closingDate > v.dueDate;
          const noHiddenFee = sameYear && next.feesYtd !== null && next.feesYtd <= keptFeesBefore(next.ytdYear!, next.closingDate) + 0.005;
          payment = { status: 'next_zero', date: null, amount: owed, onTime: sameYear ? noHiddenFee : null, source: `${shortMonth(next.closingDate)} statement opens at $0` };
        }
      } else {
        const overdue = v.dueDate ? today > v.dueDate : true;
        payment = { status: overdue ? 'unconfirmed' : 'due', date: null, amount: null, onTime: null, source: null };
      }
    }
    const purchaseCount = v.purchaseDetail.filter((p) => p.amount > 0).length;
    return {
      closingDate: v.closingDate,
      openingDate: v.openingDate,
      previousBalance: v.previousBalance,
      paid: v.paid,
      refunds: v.refunds,
      purchases: v.purchases,
      online: v.online,
      inStore: v.inStore,
      fees: v.fees,
      interest: v.interest,
      newBalance: v.newBalance,
      minimumPayment: v.minimumPayment,
      dueDate: v.dueDate,
      apr: v.purchaseApr,
      termsNotice: v.termsNotice,
      noticeApr: v.noticeApr,
      purchaseCount,
      estSavings: estSavingsOn(v.purchases - v.refunds),
      promos: v.promos,
      payment,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
    };
  });

  // ---- Items bought ----
  const items: LowesItemLine[] = [];
  for (const s of stmts) {
    for (const p of s.values.purchaseDetail) {
      items.push({
        date: p.date,
        amount: p.amount,
        where: p.online ? 'Lowes.com' : (p.store ?? 'In store'),
        online: p.online,
        items: p.items,
        category: p.amount < 0 ? 'Return' : lowesCategory(p.items),
        shipped: p.shipped,
        estSavings: p.amount > 0 ? estSavingsOn(p.amount) : 0,
        statementClosing: s.values.closingDate,
      });
    }
  }
  const catMap = new Map<string, { category: string; amount: number; count: number }>();
  for (const it of items.filter((x) => x.amount > 0)) {
    const c = catMap.get(it.category) ?? { category: it.category, amount: 0, count: 0 };
    c.amount = round2(c.amount + it.amount);
    c.count++;
    catMap.set(it.category, c);
  }
  const categories = [...catMap.values()].sort((a, b) => b.amount - a.amount);

  // ---- Years (fees / interest include anything only in the printed YTD) ----
  const byYear = new Map<number, LowesCardYear>();
  for (const r of rows) {
    const y = Number(r.closingDate.slice(0, 4));
    const cur = byYear.get(y) ?? { year: y, statements: 0, purchases: 0, refunds: 0, net: 0, online: 0, inStore: 0, estSavings: 0, vsFlat: 0, fees: 0, interest: 0, hiddenFees: 0, hiddenInterest: 0 };
    cur.statements++;
    cur.purchases = round2(cur.purchases + r.purchases);
    cur.refunds = round2(cur.refunds + r.refunds);
    cur.net = round2(cur.purchases - cur.refunds);
    cur.online = round2(cur.online + r.online);
    cur.inStore = round2(cur.inStore + r.inStore);
    cur.estSavings = round2(cur.estSavings + r.estSavings);
    cur.fees = round2(cur.fees + r.fees);
    cur.interest = round2(cur.interest + r.interest);
    byYear.set(y, cur);
  }
  for (const y of byYear.values()) {
    const inYear = stmts.filter((x) => x.values.ytdYear === y.year);
    const feesYtd = Math.max(0, ...inYear.map((x) => x.values.feesYtd ?? 0));
    const intYtd = Math.max(0, ...inYear.map((x) => x.values.interestYtd ?? 0));
    y.hiddenFees = round2(Math.max(0, feesYtd - y.fees));
    y.hiddenInterest = round2(Math.max(0, intYtd - y.interest));
    y.fees = round2(y.fees + y.hiddenFees);
    y.interest = round2(y.interest + y.hiddenInterest);
    y.vsFlat = round2(y.estSavings - y.net * LOWES_COMPARE_RATE);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  // ---- Changes ----
  const changes: LowesCardChange[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const b = stmts[i].values;
    if (b.termsNotice) changes.push({ date: b.closingDate, what: 'terms', from: b.purchaseApr !== null ? `${b.purchaseApr}%` : '—', to: b.noticeApr !== null ? `${b.noticeApr}%` : 'new terms' });
    if (!i) continue;
    const a = stmts[i - 1].values;
    if (a.purchaseApr !== null && b.purchaseApr !== null && a.purchaseApr !== b.purchaseApr) changes.push({ date: b.closingDate, what: 'apr', from: `${a.purchaseApr}%`, to: `${b.purchaseApr}%` });
    if (a.creditLine !== null && b.creditLine !== null && a.creditLine !== b.creditLine) changes.push({ date: b.closingDate, what: 'credit_line', from: `$${a.creditLine.toLocaleString('en-US')}`, to: `$${b.creditLine.toLocaleString('en-US')}` });
  }

  // ---- Activity ----
  const buys = items.filter((x) => x.amount > 0).map((x) => x.date).sort();
  let longestIdle: LowesCardSummary['longestIdle'] = null;
  for (let i = 1; i < buys.length; i++) {
    const m = monthsBetween(buys[i - 1], buys[i]);
    if (!longestIdle || m > longestIdle.months) longestIdle = { from: buys[i - 1], to: buys[i], months: m };
  }
  const lastPurchase = buys.length ? buys[buys.length - 1] : null;
  const monthsSinceUse = lastPurchase ? monthsBetween(lastPurchase, today) : null;

  const latest = rows[rows.length - 1] ?? null;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const net = (r: { purchases: number; refunds: number }) => round2(r.purchases - r.refunds);
  const since12 = addMonths(today, -12);
  const lifetimeNet = round2(rows.reduce((s, r) => s + net(r), 0));
  const lifetimePurchases = round2(rows.reduce((s, r) => s + r.purchases, 0));
  const estSavings = round2(rows.reduce((s, r) => s + r.estSavings, 0));
  const thisYear = years.find((y) => String(y.year) === today.slice(0, 4));
  const proven = (p: LowesPayment) => p.status === 'checking' || p.status === 'statement' || p.status === 'next_zero';
  const latestPaid = !latest || latest.payment.status === 'none_due' || proven(latest.payment);
  const status: LowesCardSummary['status'] = !latest
    ? 'none'
    : latest.newBalance < -0.005
      ? 'credit'
      : latestPaid
        ? 'paid'
        : latest.payment.status === 'unconfirmed'
          ? 'unconfirmed'
          : 'due';

  return {
    asOf: latest?.closingDate ?? null,
    latest,
    status,
    balance: latest?.newBalance ?? 0,
    owedNow: latest && !latestPaid ? Math.max(0, latest.newBalance) : 0,
    creditLine: lv?.creditLine ?? null,
    availableCredit: lv?.availableCredit ?? null,
    utilization: lv?.creditLine ? round2((Math.max(0, latestPaid ? 0 : lv.newBalance) / lv.creditLine) * 100) : null,
    purchaseApr: lv?.purchaseApr ?? null,
    accountLast: lv?.accountLast ?? null,
    firstStatement: rows[0]?.closingDate ?? null,
    firstPurchase: buys[0] ?? null,
    lastPurchase,
    monthsSinceUse,
    longestIdle,
    dormant: monthsSinceUse !== null && monthsSinceUse >= DORMANT_MONTHS,
    purchaseCount: buys.length,
    lifetimeNet,
    lifetimePurchases,
    last12Net: round2(rows.filter((r) => r.closingDate > since12).reduce((s, r) => s + net(r), 0)),
    ytdNet: thisYear?.net ?? 0,
    avgPurchase: buys.length ? round2(lifetimePurchases / buys.length) : null,
    onlineShare: lifetimePurchases > 0.005 ? Math.round((rows.reduce((s, r) => s + r.online, 0) / lifetimePurchases) * 100) : null,
    estSavings,
    estSavingsYtd: thisYear?.estSavings ?? 0,
    vsFlat: round2(estSavings - lifetimeNet * LOWES_COMPARE_RATE),
    totalFees: round2(years.reduce((s, y) => s + y.fees, 0)),
    totalInterest: round2(years.reduce((s, y) => s + y.interest, 0)),
    hiddenFees: round2(years.reduce((s, y) => s + y.hiddenFees, 0)),
    hiddenInterest: round2(years.reduce((s, y) => s + y.hiddenInterest, 0)),
    paidInFullCount: rows.filter((r) => proven(r.payment)).length,
    unprovenCount: rows.filter((r) => r.payment.status === 'unconfirmed').length,
    carriedStatements: rows.filter((r) => r.payment.status === 'carried' || r.interest > 0.005).map((r) => r.closingDate),
    promos: latest?.promos ?? [],
    categories,
    items: items.sort((a, b) => b.date.localeCompare(a.date)),
    changes,
    statements: rows,
    years,
    nextDue: latest && !latestPaid && latest.dueDate && latest.newBalance > 0.005 ? { date: latest.dueDate, amount: latest.newBalance, minimum: latest.minimumPayment } : null,
    checkingLinked: checking !== null,
  };
}
