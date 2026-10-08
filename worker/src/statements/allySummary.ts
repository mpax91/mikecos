import { round2 } from './common';
import type { StatementCheck } from './common';
import type { AllyAccountKind, AllyValues } from './templates/ally';

/** Pure summary of the Ally Bank statements (shared by the derive, the
 * Finance row and the dashboard). One combined statement per month covers
 * every account; accounts are keyed by last 4 digits. "Internal" transfers
 * (between two accounts in this statement) are left out of money in/out. */

export interface AllyStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // statement date (the 25th)
  values: AllyValues;
  checks: StatementCheck[];
}

export interface AllyTxnRow {
  date: string;
  account: string | null;
  description: string;
  kind: string;
  amount: number;
}

export interface AllyAccountSummary {
  last4: string;
  kind: AllyAccountKind;
  label: string; // "Checking" / "Savings"
  product: string | null;
  openDate: string | null;
  balance: number;
  apy: number | null;
  avgDailyBalance: number | null;
  interestYtd: number;
  interestLifetime: number;
  firstStatement: string;
  open: boolean; // on the latest statement
}

export interface AllyPoint {
  date: string;
  total: number;
  balances: Record<string, number>; // last4 → ending balance
}

export interface AllyApyPoint {
  date: string;
  last4: string;
  apy: number; // "Annual Percentage Yield Earned" for the period, percent
}

export interface AllyInterestYear {
  year: number;
  total: number;
  byAccount: Record<string, number>;
  statements: number; // 12 = full year
}

export interface AllyMonthFlow {
  month: string; // YYYY-MM of the statement date
  statementDate: string;
  moneyIn: number; // deposits + transfers in from outside Ally (excl. interest)
  moneyOut: number; // withdrawals + fees + transfers out (positive number)
  interest: number;
  net: number;
}

export interface AllyRecurring {
  payee: string;
  account: string | null;
  lastAmount: number;
  lastDate: string;
  typicalDay: number;
  months: number; // of the last 6 statements with a payment
}

export interface AllySummary {
  asOf: string | null;
  total: number;
  accounts: AllyAccountSummary[];
  series: AllyPoint[];
  apy: AllyApyPoint[]; // savings accounts only
  interestYears: AllyInterestYear[];
  interestLifetime: number;
  flows: AllyMonthFlow[]; // last 13 statements, oldest first
  recurring: AllyRecurring[];
  gaps: string[]; // statement months (YYYY-MM) missing between first and last
  nextExpected: string | null;
  firstStatement: string | null;
  events: { date: string; account: string | null; kind: string; description: string; amount: number }[]; // fees, overdraft transfers, returns
}

const LABEL: Record<AllyAccountKind, string> = { checking: 'Checking', savings: 'Savings', other: 'Account' };
export const accountLabel = (kind: AllyAccountKind, last4: string) => `${LABEL[kind]} ••${last4}`;

const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, 28)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** "ACH Withdrawal · ROCKET MORTGAGE LOAN~ Future Amount: 4146.71 ~ Tran:
 * ACHDW LOAN" → "Rocket Mortgage Loan". Best effort, for grouping only. */
export function payeeOf(description: string): string {
  const [, rest = description] = description.split(' · ');
  let s = rest.replace(/~.*$/, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\b(\S+)(?: \1)+$/, '$1') // "SALE SALE" → "SALE"
      .replace(/\s+(WEB_PAY|BILLPAY|AUTOPAY|PAYROLL|CREDITCARD|CONTRIB|TRANSFER|PURCHASE B|AUTO DEBIT|debitpmt|PAYMENT|ACH PMT|E-PAYMENT|ACH|SALE)$/i, '')
      .trim();
  }
  if (!s) s = description.split(' · ')[0];
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .slice(0, 48);
}

export function summarizeAlly(stmts: AllyStmtRow[], txns: AllyTxnRow[], today: string): AllySummary {
  const latest = stmts[stmts.length - 1] ?? null;
  const ownLast4 = new Set(stmts.flatMap((s) => s.values.accounts.map((a) => a.last4)));

  // ---- Accounts ----
  const interestBy = new Map<string, number>();
  const firstBy = new Map<string, string>();
  for (const s of stmts) {
    for (const a of s.values.accounts) {
      interestBy.set(a.last4, round2((interestBy.get(a.last4) ?? 0) + a.interest));
      if (!firstBy.has(a.last4)) firstBy.set(a.last4, s.periodEnd);
    }
  }
  const seen = new Map<string, { a: AllyValues['accounts'][number]; date: string }>();
  for (const s of stmts) for (const a of s.values.accounts) seen.set(a.last4, { a, date: s.periodEnd });
  const accounts: AllyAccountSummary[] = [...seen.values()]
    .map(({ a, date }) => ({
      last4: a.last4,
      kind: a.kind,
      label: LABEL[a.kind],
      product: a.product,
      openDate: a.openDate,
      balance: a.ending,
      apy: a.apy,
      avgDailyBalance: a.avgDailyBalance,
      interestYtd: latest && date === latest.periodEnd && date.slice(0, 4) === today.slice(0, 4) ? a.interestYtd ?? 0 : 0,
      interestLifetime: interestBy.get(a.last4) ?? 0,
      firstStatement: firstBy.get(a.last4)!,
      open: !!latest && date === latest.periodEnd,
    }))
    .sort((x, y) => (x.kind === y.kind ? x.last4.localeCompare(y.last4) : x.kind === 'checking' ? -1 : 1));

  // ---- Balance series ----
  const series: AllyPoint[] = stmts.map((s) => ({
    date: s.periodEnd,
    total: round2(s.values.accounts.reduce((t, a) => t + a.ending, 0)),
    balances: Object.fromEntries(s.values.accounts.map((a) => [a.last4, a.ending])),
  }));

  // ---- APY earned (savings: the rate; checking's varies with balance
  // tiers, so it isn't tracked). A month with no balance prints 0.00%.
  const apy: AllyApyPoint[] = [];
  for (const s of stmts) {
    for (const a of s.values.accounts) {
      if (a.kind !== 'savings' || a.apy === null || (a.apy === 0 && (a.avgDailyBalance ?? 0) < 1)) continue;
      apy.push({ date: s.periodEnd, last4: a.last4, apy: a.apy });
    }
  }

  // ---- Interest by year (paid on the 25th → statement year = tax year) ----
  const years = new Map<number, AllyInterestYear>();
  for (const s of stmts) {
    const y = Number(s.periodEnd.slice(0, 4));
    const row = years.get(y) ?? { year: y, total: 0, byAccount: {}, statements: 0 };
    row.statements++;
    for (const a of s.values.accounts) {
      row.byAccount[a.last4] = round2((row.byAccount[a.last4] ?? 0) + a.interest);
      row.total = round2(row.total + a.interest);
    }
    years.set(y, row);
  }
  const interestYears = [...years.values()].sort((a, b) => a.year - b.year);

  // ---- Money in / out per statement (outside-Ally money only) ----
  const internal = (t: AllyTxnRow) => {
    if (t.kind !== 'transfer_in' && t.kind !== 'transfer_out') return false;
    if (t.description.startsWith('Overdraft Transfer')) return true; // always from the linked savings
    const m = t.description.match(/(?:X{4,}|x{4,}|\b\d{6})(\d{4})\b/);
    return !!m && ownLast4.has(m[1]) && m[1] !== t.account;
  };
  const byStmt = new Map<string, AllyMonthFlow>();
  const stmtFor = (date: string) => stmts.find((s) => s.periodEnd >= date)?.periodEnd ?? null;
  for (const t of txns) {
    const end = stmtFor(t.date);
    if (!end) continue;
    const f = byStmt.get(end) ?? { month: end.slice(0, 7), statementDate: end, moneyIn: 0, moneyOut: 0, interest: 0, net: 0 };
    if (t.kind === 'interest') f.interest = round2(f.interest + t.amount);
    else if (!internal(t)) {
      if (t.amount >= 0) f.moneyIn = round2(f.moneyIn + t.amount);
      else f.moneyOut = round2(f.moneyOut - t.amount);
    }
    f.net = round2(f.moneyIn - f.moneyOut + f.interest);
    byStmt.set(end, f);
  }
  const flows = stmts.slice(-13).map((s) => byStmt.get(s.periodEnd) ?? { month: s.periodEnd.slice(0, 7), statementDate: s.periodEnd, moneyIn: 0, moneyOut: 0, interest: 0, net: 0 });

  // ---- Recurring payments: same payee in ≥3 of the last 6 statements ----
  const windowStart = stmts.length > 6 ? stmts[stmts.length - 7].periodEnd : '';
  const groups = new Map<string, AllyTxnRow[]>();
  for (const t of txns) {
    if (t.date <= windowStart) continue;
    if (t.amount >= 0 || t.kind === 'interest' || internal(t)) continue;
    if (t.kind === 'transfer_out') continue;
    const key = `${t.account ?? ''}|${payeeOf(t.description)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const recurring: AllyRecurring[] = [];
  for (const [key, list] of groups) {
    const months = new Set(list.map((t) => stmtFor(t.date)).filter(Boolean)).size;
    if (months < 3) continue;
    const last = list[list.length - 1];
    const days = list.map((t) => Number(t.date.slice(8, 10))).sort((a, b) => a - b);
    recurring.push({ payee: key.split('|')[1], account: last.account, lastAmount: -last.amount, lastDate: last.date, typicalDay: days[Math.floor(days.length / 2)], months });
  }
  recurring.sort((a, b) => a.typicalDay - b.typicalDay || b.lastAmount - a.lastAmount);

  // ---- Coverage: one statement a month ----
  const months = new Set(stmts.map((s) => s.periodEnd.slice(0, 7)));
  const gaps: string[] = [];
  if (stmts.length > 1) {
    for (let m = stmts[0].periodEnd; m.slice(0, 7) < latest!.periodEnd.slice(0, 7); m = addMonths(m, 1)) {
      if (!months.has(m.slice(0, 7))) gaps.push(m.slice(0, 7));
    }
  }

  const events = txns
    .filter((t) => t.kind === 'fee' || /Overdraft Transfer|ACH Return/.test(t.description))
    .map((t) => ({ date: t.date, account: t.account, kind: t.kind, description: t.description, amount: t.amount }));

  return {
    asOf: latest?.periodEnd ?? null,
    total: latest ? round2(latest.values.accounts.reduce((t, a) => t + a.ending, 0)) : 0,
    accounts,
    series,
    apy,
    interestYears,
    interestLifetime: round2([...interestBy.values()].reduce((a, b) => a + b, 0)),
    flows,
    recurring,
    gaps,
    nextExpected: latest ? addMonths(latest.periodEnd, 1) : null,
    firstStatement: stmts[0]?.periodEnd ?? null,
    events,
  };
}
