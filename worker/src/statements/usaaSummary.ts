import { round2 } from './common';
import type { StatementCheck } from './common';
import type { UsaaValues } from './templates/usaa';
import type { CashStatement } from './cashPlacement';

/** Pure summary of the USAA checking statements (shared by the derive, the
 * Finance row, Cash Placement and the dashboard). One account; money is
 * grouped into categories by rule (payroll, card payments, sportsbooks,
 * Venmo/Zelle/PayPal, transfers between Mike's own accounts, …) — no AI. */

export interface UsaaStmtRow {
  id: string;
  fileId: string;
  periodEnd: string;
  values: UsaaValues;
  checks: StatementCheck[];
}

export interface UsaaTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export type UsaaCategory =
  | 'Paychecks'
  | 'Unemployment'
  | 'Card Payments'
  | 'Transfers'
  | 'Sportsbooks'
  | 'Venmo, Zelle & PayPal'
  | 'Checks'
  | 'Cash & ATM'
  | 'Deposits'
  | 'Debit Card'
  | 'Bedford Bee (Stripe)'
  | 'Interest'
  | 'Fees'
  | 'Bills & Other';

export const USAA_CATEGORIES: UsaaCategory[] = [
  'Paychecks',
  'Unemployment',
  'Card Payments',
  'Transfers',
  'Sportsbooks',
  'Venmo, Zelle & PayPal',
  'Checks',
  'Cash & ATM',
  'Deposits',
  'Debit Card',
  'Bedford Bee (Stripe)',
  'Interest',
  'Fees',
  'Bills & Other',
];

const SPORTSBOOK = /DRAFTKINGS|FANDUEL|FD SPTSBK|BETMGM|CAESARS|CZR SB|BETRIVERS|RSI US|AMERICAN WAGER|WILLIAM HILL|POINTSBET|FANATICS|ESPN ?BET|RESORTS WORLD BET/i;

/** Rule-based category for one transaction. */
export function categoryOf(t: { description: string; kind: string; amount: number }): UsaaCategory {
  const d = t.description.toUpperCase();
  if (t.kind === 'interest') return 'Interest';
  if (t.kind === 'fee') return 'Fees';
  if (t.kind === 'transfer_in' || t.kind === 'transfer_out') return 'Transfers';
  if (t.kind === 'payment') return 'Card Payments';
  if (SPORTSBOOK.test(d)) return 'Sportsbooks';
  if (/NYS DOL|UNEMPLOY/.test(d)) return 'Unemployment';
  if (/PAYROLL|DIR DEP|DIRECT DEP|PAYRLL|SALARY/.test(d)) return 'Paychecks';
  if (/STRIPE/.test(d)) return 'Bedford Bee (Stripe)';
  if (/VENMO|ZELLE|PAYPAL|SEND MONEY|CASH APP|SQUARE CASH/.test(d)) return 'Venmo, Zelle & PayPal';
  if (/^CHECK #/.test(d)) return 'Checks';
  if (/\bATM\b/.test(d)) return 'Cash & ATM';
  if (/DEBIT CARD|POS PURCHASE|\bPOS\b/.test(d)) return 'Debit Card';
  // Any other money in (mobile/mail deposits, reimbursements, payouts).
  if (t.amount > 0) return 'Deposits';
  return 'Bills & Other';
}

/** "ACH Withdrawal · CHASE CREDIT CRD EPAY" → "Chase Credit Crd Epay" — for
 * grouping only. */
export function payeeOf(description: string): string {
  const [type, rest = ''] = description.split(' · ');
  let s = rest
    .replace(/\$[\d,.]+.*$/, '') // "ATM Rebate · $204.00 ATM W/D …"
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\s+(ViaTrustly|PAYMENT|PAYMNT|PMT|PYMT|EPAY|E-PAYMENT|ONLINE PMT|WEB PYMT|ACH PMT|BILL PAY|PAYROLL|DIR DEP|INTERNET|PURCHASE|CASHOUT|DEBITS|CREDITS|Funds|TRANSFER|CCPYMT|ONLINE|WEB|INC\.?)$/i, '')
      .trim();
  }
  if (!s) s = /^Check #/.test(type) ? 'Checks' : type;
  if (/^Zelle:/i.test(s)) s = s.replace(/^Zelle:\s*/i, 'Zelle · ');
  return s
    .toLowerCase()
    .replace(/(^|[\s·(/-])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/\bUsaa\b/g, 'USAA')
    .replace(/\bNys Dol\b/g, 'NYS DOL')
    .replace(/\bAtm\b/g, 'ATM')
    .slice(0, 48);
}

/** Card payments → issuer. */
export function issuerOf(description: string): string {
  const d = description.toUpperCase();
  const map: [RegExp, string][] = [
    [/CHASE/, 'Chase'],
    [/AMEX|AMERICAN EXPRESS/, 'American Express'],
    [/BK OF AMER|BANK OF AMERICA/, 'Bank of America'],
    [/DISCOVER/, 'Discover'],
    [/WELLS FARGO/, 'Wells Fargo'],
    [/CARDMEMBER SERV/, 'Cardmember Service'],
    [/U\.?S\.? BANK/, 'U.S. Bank'],
    [/TARGET/, 'Target'],
    [/CAPITAL ONE|CAP ONE/, 'Capital One'],
    [/BARCLAY/, 'Barclaycard'],
    [/CITI/, 'Citi'],
    [/USAA CREDIT CARD/, 'USAA Credit Card'],
    [/HOME DEPOT/, 'Home Depot'],
    [/LOWES|SYF|SYNCHRONY/, 'Synchrony (Lowe’s)'],
    [/KOHL/, 'Kohl’s'],
    [/CREDIT CARD WEB PYMT/, 'Credit Card (web payment)'],
  ];
  return map.find(([re]) => re.test(d))?.[1] ?? payeeOf(description);
}

export interface UsaaPoint {
  date: string; // statement end
  start: string;
  balance: number;
  avg: number | null;
  low: number | null;
  lowDate: string | null;
  apy: number | null;
}

export interface UsaaFlow {
  date: string; // statement end
  start: string;
  moneyIn: number; // deposits from outside Mike's accounts (no interest, no own transfers)
  moneyOut: number; // spending + card payments + fees (positive)
  transfersIn: number;
  transfersOut: number; // positive
  interest: number;
  net: number; // moneyIn − moneyOut + interest
  byCategory: Partial<Record<UsaaCategory, number>>; // signed totals
}

export interface UsaaInterestYear {
  year: number;
  total: number;
  statements: number;
  december: boolean; // the year's last statement is in
}

export interface UsaaIssuer {
  issuer: string;
  count: number;
  total: number; // positive, last 12 months
  lastDate: string;
  lastAmount: number;
}

export interface UsaaRecurring {
  payee: string;
  category: UsaaCategory;
  lastAmount: number;
  lastDate: string;
  typicalDay: number;
  months: number; // of the last 6 statements with a payment
}

export interface UsaaEvent {
  date: string;
  kind: 'fee' | 'overdrawn' | 'returned';
  description: string;
  amount: number;
}

export interface UsaaSummary {
  asOf: string | null;
  last4: string | null;
  label: string; // "Checking ••1234"
  product: string | null;
  holder: string | null;
  balance: number;
  apy: number | null;
  avgDailyBalance: number | null;
  interestYtd: number;
  interestLifetime: number;
  interestYears: UsaaInterestYear[];
  series: UsaaPoint[];
  flows: UsaaFlow[]; // every statement, oldest first
  issuers: UsaaIssuer[];
  recurring: UsaaRecurring[];
  events: UsaaEvent[];
  checksWritten: { year: number; count: number; total: number }[];
  gaps: string[];
  firstStatement: string | null;
  nextExpected: string | null;
  overdrawnDays12: number; // statements in the last 12 with a negative day
}

const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, 28)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** The statement (end date) a transaction belongs to. */
function stmtIndexer(stmts: UsaaStmtRow[]) {
  return (date: string) => {
    // Statements are short and ordered; find the first whose end ≥ date.
    let lo = 0;
    let hi = stmts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (stmts[mid].periodEnd >= date) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  };
}

/** USAA's side of Cash Placement (cashPlacement.ts). Outflow = money that
 * left for outside Mike's accounts (transfers to his own savings /
 * brokerage are left out — they aren't bills the buffer must cover). */
export function usaaCashStatements(stmts: UsaaStmtRow[], txns: UsaaTxnRow[]): CashStatement[] {
  const idx = stmtIndexer(stmts);
  const out = new Array(stmts.length).fill(0) as number[];
  for (const t of txns) {
    if (t.amount >= 0 || t.kind === 'transfer_out') continue;
    const i = idx(t.date);
    if (i >= 0) out[i] = round2(out[i] - t.amount);
  }
  return stmts.map((s, i) => ({
    date: s.periodEnd,
    accounts: [
      {
        last4: s.values.last4,
        kind: 'checking' as const,
        label: `Checking ••${s.values.last4}`,
        balance: s.values.ending,
        apy: s.values.apy,
        avgBalance: s.values.avgDailyBalance,
        outflow: out[i],
      },
    ],
  }));
}

export function summarizeUsaa(stmts: UsaaStmtRow[], txns: UsaaTxnRow[], today: string): UsaaSummary {
  const latest = stmts[stmts.length - 1] ?? null;
  const idx = stmtIndexer(stmts);
  const year = today.slice(0, 4);

  // ---- Per-statement flows + categories ----
  const flows: UsaaFlow[] = stmts.map((s) => ({ date: s.periodEnd, start: s.values.periodStart, moneyIn: 0, moneyOut: 0, transfersIn: 0, transfersOut: 0, interest: 0, net: 0, byCategory: {} }));
  for (const t of txns) {
    const i = idx(t.date);
    if (i < 0) continue;
    const f = flows[i];
    const cat = categoryOf(t);
    f.byCategory[cat] = round2((f.byCategory[cat] ?? 0) + t.amount);
    if (t.kind === 'interest') f.interest = round2(f.interest + t.amount);
    else if (t.kind === 'transfer_in') f.transfersIn = round2(f.transfersIn + t.amount);
    else if (t.kind === 'transfer_out') f.transfersOut = round2(f.transfersOut - t.amount);
    else if (t.amount >= 0) f.moneyIn = round2(f.moneyIn + t.amount);
    else f.moneyOut = round2(f.moneyOut - t.amount);
  }
  for (const f of flows) f.net = round2(f.moneyIn - f.moneyOut + f.interest);

  // ---- Balance series ----
  const series: UsaaPoint[] = stmts.map((s) => ({ date: s.periodEnd, start: s.values.periodStart, balance: s.values.ending, avg: s.values.avgDailyBalance, low: s.values.lowBalance, lowDate: s.values.lowDate, apy: s.values.apy }));

  // ---- Interest by year (credited on the statement date → statement year) ----
  const years = new Map<number, UsaaInterestYear>();
  for (const s of stmts) {
    const y = Number(s.periodEnd.slice(0, 4));
    const row = years.get(y) ?? { year: y, total: 0, statements: 0, december: false };
    row.total = round2(row.total + s.values.interest);
    row.statements++;
    if (s.periodEnd.slice(5, 7) === '12') row.december = true;
    years.set(y, row);
  }
  const interestYears = [...years.values()].sort((a, b) => a.year - b.year);

  // ---- Card payments by issuer, last 12 months ----
  const since12 = addMonths(today, -12);
  const issuers = new Map<string, UsaaIssuer>();
  for (const t of txns) {
    if (t.kind !== 'payment' || t.date <= since12) continue;
    const name = issuerOf(t.description);
    const row = issuers.get(name) ?? { issuer: name, count: 0, total: 0, lastDate: t.date, lastAmount: -t.amount };
    row.count++;
    row.total = round2(row.total - t.amount);
    if (t.date >= row.lastDate) {
      row.lastDate = t.date;
      row.lastAmount = -t.amount;
    }
    issuers.set(name, row);
  }

  // ---- Recurring: same payee in ≥3 of the last 6 statements ----
  const windowStart = stmts.length > 6 ? stmts[stmts.length - 7].periodEnd : '';
  const groups = new Map<string, UsaaTxnRow[]>();
  for (const t of txns) {
    if (t.date <= windowStart || t.amount >= 0) continue;
    if (t.kind === 'transfer_out' || t.kind === 'fee') continue;
    const cat = categoryOf(t);
    if (cat === 'Sportsbooks' || cat === 'Cash & ATM' || cat === 'Checks') continue;
    const key = t.kind === 'payment' ? `Card · ${issuerOf(t.description)}` : payeeOf(t.description);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const recurring: UsaaRecurring[] = [];
  for (const [payee, list] of groups) {
    const months = new Set(list.map((t) => idx(t.date))).size;
    if (months < 3) continue;
    const last = list[list.length - 1];
    const days = list.map((t) => Number(t.date.slice(8, 10))).sort((a, b) => a - b);
    recurring.push({ payee, category: categoryOf(last), lastAmount: -last.amount, lastDate: last.date, typicalDay: days[Math.floor(days.length / 2)], months });
  }
  recurring.sort((a, b) => a.typicalDay - b.typicalDay || b.lastAmount - a.lastAmount);

  // ---- Events: fees, returned items, overdrawn days ----
  const events: UsaaEvent[] = [];
  for (const t of txns) {
    if (t.kind === 'fee') events.push({ date: t.date, kind: 'fee', description: t.description, amount: t.amount });
    else if (/RETURNED|NSF REV|RETURN ITEM/i.test(t.description)) events.push({ date: t.date, kind: 'returned', description: t.description, amount: t.amount });
  }
  for (const s of stmts) {
    if (s.values.lowBalance !== null && s.values.lowBalance < 0) events.push({ date: s.values.lowDate ?? s.periodEnd, kind: 'overdrawn', description: `Balance went negative (low ${s.values.lowBalance.toFixed(2)})`, amount: s.values.lowBalance });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // ---- Checks written per year ----
  const cw = new Map<number, { year: number; count: number; total: number }>();
  for (const s of stmts) {
    for (const c of s.values.checks) {
      const y = Number(c.date.slice(0, 4));
      const row = cw.get(y) ?? { year: y, count: 0, total: 0 };
      row.count++;
      row.total = round2(row.total + c.amount);
      cw.set(y, row);
    }
  }

  // ---- Coverage: one statement a month ----
  const months = new Set(stmts.map((s) => s.periodEnd.slice(0, 7)));
  const gaps: string[] = [];
  if (stmts.length > 1) {
    for (let m = stmts[0].periodEnd; m.slice(0, 7) < latest!.periodEnd.slice(0, 7); m = addMonths(m, 1)) {
      if (!months.has(m.slice(0, 7))) gaps.push(m.slice(0, 7));
    }
  }

  const interestYtd = round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((t, s) => t + s.values.interest, 0));
  return {
    asOf: latest?.periodEnd ?? null,
    last4: latest?.values.last4 ?? null,
    label: latest ? `Checking ••${latest.values.last4}` : 'Checking',
    product: latest?.values.product ?? null,
    holder: latest?.values.holder ?? null,
    balance: latest?.values.ending ?? 0,
    apy: latest?.values.apy ?? null,
    avgDailyBalance: latest?.values.avgDailyBalance ?? null,
    interestYtd,
    interestLifetime: round2(stmts.reduce((t, s) => t + s.values.interest, 0)),
    interestYears,
    series,
    flows,
    issuers: [...issuers.values()].sort((a, b) => b.total - a.total),
    recurring,
    events,
    checksWritten: [...cw.values()].sort((a, b) => a.year - b.year),
    gaps,
    firstStatement: stmts[0]?.periodEnd ?? null,
    nextExpected: latest ? addMonths(latest.periodEnd, 1) : null,
    overdrawnDays12: stmts.slice(-12).filter((s) => (s.values.lowBalance ?? 0) < 0).length,
  };
}
