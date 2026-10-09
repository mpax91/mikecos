import { round2 } from './common';
import type { StatementCheck } from './common';
import type { AmexBankValues } from './templates/amexBank';
import type { CashStatement } from './cashPlacement';

/** Pure summary of the American Express High Yield Savings statements
 * (shared by the derive, the Finance row and the dashboard). One account
 * (Savings ••8815); interest is credited on the statement date, so the
 * statement's year is the tax year. */

export interface AmexStmtRow {
  id: string;
  fileId: string;
  periodEnd: string;
  values: AmexBankValues;
  checks: StatementCheck[];
}

export interface AmexTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface AmexApyPoint {
  date: string;
  apy: number; // stated APY when printed, else APY earned
  earned: number | null;
}

export interface AmexRateChange {
  date: string; // statement the new rate first shows on
  from: number;
  to: number;
}

export interface AmexInterestYear {
  year: number;
  total: number;
  statements: number;
  december: boolean; // has the December statement → full tax year
}

export interface AmexMonthFlow {
  month: string;
  statementDate: string;
  moneyIn: number; // deposits (excl. interest)
  moneyOut: number; // withdrawals + fees (positive)
  interest: number;
  net: number;
}

export interface AmexCounterparty {
  name: string;
  moneyIn: number;
  moneyOut: number;
  count: number;
  lastDate: string;
}

export interface AmexBankSummary {
  asOf: string | null;
  last4: string | null;
  label: string;
  product: string | null;
  holders: string | null;
  balance: number;
  apy: number | null;
  rate: number | null;
  interestYtd: number;
  interestLifetime: number;
  firstStatement: string | null;
  series: { date: string; balance: number }[];
  apyPoints: AmexApyPoint[];
  rateChanges: AmexRateChange[];
  interestYears: AmexInterestYear[];
  flows: AmexMonthFlow[]; // last 13 statements, oldest first
  counterparties: AmexCounterparty[]; // last 24 months, by total moved
  gaps: string[];
  nextExpected: string | null;
  events: { date: string; kind: string; description: string; amount: number }[]; // fees
}

export const amexLabel = (last4: string | null) => `Savings ••${last4 ?? '????'}`;

const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, 28)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** "ACH Deposit · USAA CHK-INTRNT TRANSFER · Sender: M PALLADINO" →
 * "Usaa Chk-Intrnt Transfer". For grouping only. */
export function counterpartyName(description: string): string {
  const parts = description.split(' · ');
  const raw = (parts[1] ?? parts[0]).replace(/\s+/g, ' ').trim();
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .slice(0, 48);
}

/** The rate a statement shows: the stated APY in effect (2016+), else the
 * APY earned for the period. */
export const statementApy = (v: AmexBankValues) => v.apy ?? v.apyEarned;

/** American Express's side of Cash Placement (cashPlacement.ts). Savings
 * only — the idle-checking rule never applies, the cross-bank rule does. */
export function amexCashStatements(stmts: AmexStmtRow[], txns: AmexTxnRow[]): CashStatement[] {
  const out = new Map<string, number>();
  let i = 0;
  for (const t of txns) {
    while (i < stmts.length && stmts[i].periodEnd < t.date) i++;
    if (i >= stmts.length) break;
    if (t.amount < 0) out.set(stmts[i].periodEnd, round2((out.get(stmts[i].periodEnd) ?? 0) - t.amount));
  }
  return stmts.map((s) => ({
    date: s.periodEnd,
    accounts: [
      {
        last4: s.values.last4,
        kind: 'savings' as const,
        label: amexLabel(s.values.last4),
        balance: s.values.ending,
        apy: s.values.apyEarned ?? s.values.apy,
        avgBalance: s.values.avgBalance,
        outflow: out.get(s.periodEnd) ?? 0,
      },
    ],
  }));
}

export function summarizeAmexBank(stmts: AmexStmtRow[], txns: AmexTxnRow[], today: string): AmexBankSummary {
  const latest = stmts[stmts.length - 1] ?? null;
  const v = latest?.values ?? null;

  const series = stmts.map((s) => ({ date: s.periodEnd, balance: s.values.ending }));

  // APY: a month with no balance can print 0.00% earned — leave those out.
  const apyPoints: AmexApyPoint[] = [];
  for (const s of stmts) {
    const apy = statementApy(s.values);
    if (apy === null || (apy === 0 && s.values.ending < 1)) continue;
    apyPoints.push({ date: s.periodEnd, apy, earned: s.values.apyEarned });
  }
  const rateChanges: AmexRateChange[] = [];
  for (let i = 1; i < apyPoints.length; i++) {
    if (Math.abs(apyPoints[i].apy - apyPoints[i - 1].apy) >= 0.005) rateChanges.push({ date: apyPoints[i].date, from: apyPoints[i - 1].apy, to: apyPoints[i].apy });
  }

  const years = new Map<number, AmexInterestYear>();
  for (const s of stmts) {
    const y = Number(s.periodEnd.slice(0, 4));
    const row = years.get(y) ?? { year: y, total: 0, statements: 0, december: false };
    row.statements++;
    row.total = round2(row.total + s.values.interest);
    if (s.periodEnd.slice(5, 7) === '12') row.december = true;
    years.set(y, row);
  }
  const interestYears = [...years.values()].sort((a, b) => a.year - b.year);

  // ---- Money in / out per statement ----
  const stmtFor = (date: string) => stmts.find((s) => s.periodEnd >= date)?.periodEnd ?? null;
  const byStmt = new Map<string, AmexMonthFlow>();
  for (const t of txns) {
    const end = stmtFor(t.date);
    if (!end) continue;
    const f = byStmt.get(end) ?? { month: end.slice(0, 7), statementDate: end, moneyIn: 0, moneyOut: 0, interest: 0, net: 0 };
    if (t.kind === 'interest') f.interest = round2(f.interest + t.amount);
    else if (t.amount >= 0) f.moneyIn = round2(f.moneyIn + t.amount);
    else f.moneyOut = round2(f.moneyOut - t.amount);
    f.net = round2(f.moneyIn - f.moneyOut + f.interest);
    byStmt.set(end, f);
  }
  const flows = stmts.slice(-13).map((s) => byStmt.get(s.periodEnd) ?? { month: s.periodEnd.slice(0, 7), statementDate: s.periodEnd, moneyIn: 0, moneyOut: 0, interest: 0, net: 0 });

  // ---- Counterparties (last 24 statements) ----
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const cps = new Map<string, AmexCounterparty>();
  for (const t of txns) {
    if (t.date <= since || t.kind === 'interest') continue;
    const name = counterpartyName(t.description);
    const c = cps.get(name) ?? { name, moneyIn: 0, moneyOut: 0, count: 0, lastDate: t.date };
    if (t.amount >= 0) c.moneyIn = round2(c.moneyIn + t.amount);
    else c.moneyOut = round2(c.moneyOut - t.amount);
    c.count++;
    if (t.date > c.lastDate) c.lastDate = t.date;
    cps.set(name, c);
  }
  const counterparties = [...cps.values()].sort((a, b) => b.moneyIn + b.moneyOut - (a.moneyIn + a.moneyOut)).slice(0, 12);

  // ---- Coverage: one statement a month ----
  const months = new Set(stmts.map((s) => s.periodEnd.slice(0, 7)));
  const gaps: string[] = [];
  if (stmts.length > 1) {
    for (let m = stmts[0].periodEnd; m.slice(0, 7) < latest!.periodEnd.slice(0, 7); m = addMonths(m, 1)) {
      if (!months.has(m.slice(0, 7))) gaps.push(m.slice(0, 7));
    }
  }

  return {
    asOf: latest?.periodEnd ?? null,
    last4: v?.last4 ?? null,
    label: amexLabel(v?.last4 ?? null),
    product: v?.product ?? null,
    holders: v?.holders ?? null,
    balance: v?.ending ?? 0,
    apy: v ? statementApy(v) : null,
    rate: v?.rate ?? null,
    interestYtd: v && v.statementDate.slice(0, 4) === today.slice(0, 4) ? v.interestYtd ?? interestYears.find((y) => y.year === Number(today.slice(0, 4)))?.total ?? 0 : 0,
    interestLifetime: round2(stmts.reduce((t, s) => t + s.values.interest, 0)),
    firstStatement: stmts[0]?.periodEnd ?? null,
    series,
    apyPoints,
    rateChanges,
    interestYears,
    flows,
    counterparties,
    gaps,
    nextExpected: latest ? addMonths(latest.periodEnd, 1) : null,
    events: txns.filter((t) => t.kind === 'fee').map((t) => ({ date: t.date, kind: t.kind, description: t.description, amount: t.amount })),
  };
}
