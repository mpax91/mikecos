import { round2 } from './common';
import type { StatementCheck } from './common';
import type { TargetCardValues } from './templates/targetCard';
import { isOnline } from './templates/targetCard';
import { addMonths } from './adtSummary';

/** Pure summary of the Target RedCard / Circle Card statements (shared by
 * the derive, the Finance row and the dashboard). Money owed is positive.
 *
 * Savings: the 5% discount comes off at the register, so the "reward" is
 * what each statement prints as savings so far this calendar year. A
 * statement's own savings = its year-to-date figure minus the last one
 * printed earlier that year (January statements of the classic layout
 * don't print it — their savings land on the next statement). A year's
 * total = the last figure printed that year, so savings on purchases after
 * the year's last closing (≈ Dec 20–31) aren't counted anywhere.
 *
 * Target only sends a statement for a month with activity or a balance. A
 * statement with a balance is always followed by one (the month it's paid),
 * so only that next month can be "missing"; later empty months are quiet. */

export interface TargetCardStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string;
  values: TargetCardValues;
  checks: StatementCheck[];
}

export interface TargetCardTxnRow {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface TargetCardStatementRow {
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
  carried: number; // previous balance left unpaid during the period
  apr: number | null;
  savingsYtd: number | null;
  savings: number | null; // this statement's share of the year's savings
  /** The statement's payment = the previous statement's full balance, on
   * its due date (or a day after). null = no payment. Target statements never
   * say whether a payment was AutoPay, so this is NOT evidence of AutoPay. */
  paidInFullOnDue: boolean | null;
  paidLate: boolean; // a payment that landed after the previous due date
  fileId: string;
  checksOk: boolean;
}

export interface TargetCardYear {
  year: number;
  statements: number;
  purchases: number;
  refunds: number;
  net: number;
  online: number;
  inStore: number;
  savings: number; // last "saved this year" figure printed that year
  savingsAsOf: string | null;
  rate: number | null; // savings ÷ net purchases, percent
  fees: number;
  interest: number;
  partial: boolean;
}

export interface TargetCardCharge {
  date: string;
  description: string;
  kind: 'fee' | 'interest' | 'credit';
  amount: number;
}

export interface TargetCardChange {
  date: string;
  what: 'apr' | 'credit_line' | 'renamed';
  from: string;
  to: string;
}

export interface TargetGaps {
  missing: string[];
  quiet: string[];
}

export interface TargetCardSummary {
  asOf: string | null;
  latest: TargetCardStatementRow | null;
  status: 'paid' | 'due' | 'credit' | 'none';
  balance: number;
  cardName: string;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null;
  purchaseApr: number | null;
  savingsYtd: number; // this calendar year so far (0 when no statement this year)
  savingsYtdAsOf: string | null;
  lifetimeSavings: number;
  savingsRate: number | null; // lifetime savings ÷ net purchases, percent
  rate12: number | null; // last 12 months
  last12Net: number;
  ytdNet: number;
  lifetimeNet: number;
  lifetimePurchases: number;
  onlineShare: number | null; // % of purchases on Target.com (lifetime)
  firstStatement: string | null;
  activeMonths: number; // statements with a purchase
  lastPurchase: string | null;
  paidInFullStreak: number;
  carriedStatements: string[];
  lateFees: { date: string; amount: number }[];
  totalFees: number;
  totalInterest: number;
  charges: TargetCardCharge[];
  changes: TargetCardChange[];
  statements: TargetCardStatementRow[];
  years: TargetCardYear[];
  nextStatementExpected: string | null;
  /** A statement is due only while there's a balance (it'll show the payment). */
  expectNext: boolean;
  nextDue: { date: string; amount: number; minimum: number } | null;
}

const ym = (iso: string) => iso.slice(0, 7);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function targetGaps(stmts: TargetCardStmtRow[], files: { file_name: string; status: string }[]): TargetGaps {
  const out: TargetGaps = { missing: [], quiet: [] };
  const have = new Set(stmts.map((s) => ym(s.periodEnd)));
  for (const f of files) {
    if (f.status === 'skipped' || f.status === 'duplicate' || f.status === 'parsed') continue;
    const m = f.file_name.match(/(\d{4})\.(\d{2})/);
    if (m) have.add(`${m[1]}-${m[2]}`);
  }
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    const months: string[] = [];
    for (let d = addMonths(a.closingDate, 1); ym(d) < ym(b.closingDate); d = addMonths(d, 1)) if (!have.has(ym(d))) months.push(ym(d));
    months.forEach((m, k) => {
      // The month after a balance must have a statement (the payment);
      // after that, an empty month only stays quiet if nothing carried in.
      const missing = (k === 0 && Math.abs(a.newBalance) >= 0.005) || Math.abs(b.previousBalance) >= 0.005;
      (missing ? out.missing : out.quiet).push(m);
    });
  }
  return out;
}

export function summarizeTargetCard(stmts: TargetCardStmtRow[], txns: TargetCardTxnRow[], today: string): TargetCardSummary {
  const year = today.slice(0, 4);
  const lastYtd = new Map<string, number>(); // year → last printed YTD
  const rows: TargetCardStatementRow[] = stmts.map((s, i) => {
    const v = s.values;
    const prev = i ? stmts[i - 1].values : null;
    const y = v.closingDate.slice(0, 4);
    let savings: number | null = null;
    if (v.savingsYtd !== null) {
      savings = round2(Math.max(0, v.savingsYtd - (lastYtd.get(y) ?? 0)));
      lastYtd.set(y, v.savingsYtd);
    }
    let paidInFullOnDue: boolean | null = null;
    let paidLate = false;
    const pays = txns.filter((t) => t.statementId === s.id && t.kind === 'payment');
    if (pays.length) {
      paidInFullOnDue = false;
      if (prev && prev.dueDate && prev.newBalance > 0.005) {
        paidInFullOnDue = pays.some((p) => Math.abs(-p.amount - prev.newBalance) < 0.005 && p.date >= prev.dueDate! && p.date <= addDays(prev.dueDate!, 1));
        paidLate = pays.every((p) => p.date > prev.dueDate!);
      }
    }
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
      carried: Math.max(0, round2(v.previousBalance - v.paid - v.refunds)),
      apr: v.purchaseApr,
      savingsYtd: v.savingsYtd,
      savings,
      paidInFullOnDue,
      paidLate,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
    };
  });
  const latest = rows[rows.length - 1] ?? null;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const net = (r: { purchases: number; refunds: number }) => round2(r.purchases - r.refunds);

  // ---- Years ----
  const byYear = new Map<number, TargetCardYear>();
  rows.forEach((r) => {
    const y = Number(r.closingDate.slice(0, 4));
    const cur = byYear.get(y) ?? { year: y, statements: 0, purchases: 0, refunds: 0, net: 0, online: 0, inStore: 0, savings: 0, savingsAsOf: null, rate: null, fees: 0, interest: 0, partial: false };
    cur.statements++;
    cur.purchases = round2(cur.purchases + r.purchases);
    cur.refunds = round2(cur.refunds + r.refunds);
    cur.net = round2(cur.purchases - cur.refunds);
    cur.online = round2(cur.online + r.online);
    cur.inStore = round2(cur.inStore + r.inStore);
    cur.fees = round2(cur.fees + r.fees);
    cur.interest = round2(cur.interest + r.interest);
    if (r.savingsYtd !== null && r.savingsYtd >= cur.savings) {
      cur.savings = r.savingsYtd;
      cur.savingsAsOf = r.closingDate;
    }
    byYear.set(y, cur);
  });
  for (const y of byYear.values()) {
    y.rate = y.net > 0.005 ? round2((y.savings / y.net) * 100) : null;
    y.partial = String(y.year) === year || y.year === Number(rows[0]?.closingDate.slice(0, 4));
    const inYear = stmts.filter((x) => x.values.ytdYear === y.year);
    const feesYtd = Math.max(0, ...inYear.map((x) => x.values.feesYtd ?? 0));
    const intYtd = Math.max(0, ...inYear.map((x) => x.values.interestYtd ?? 0));
    if (feesYtd > y.fees + 0.005) y.fees = round2(feesYtd);
    if (intYtd > y.interest + 0.005) y.interest = round2(intYtd);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  // ---- Fees & changes ----
  const charges: TargetCardCharge[] = txns
    .filter((t) => t.kind === 'fee' || t.kind === 'interest' || t.kind === 'adjustment')
    .map((t) => ({ date: t.date, description: t.description, kind: t.kind === 'adjustment' ? ('credit' as const) : (t.kind as 'fee' | 'interest'), amount: t.amount }));
  const lateFees = txns.filter((t) => t.kind === 'fee' && /LATE/i.test(t.description)).map((t) => ({ date: t.date, amount: t.amount }));
  const changes: TargetCardChange[] = [];
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    if (a.purchaseApr !== null && b.purchaseApr !== null && a.purchaseApr !== b.purchaseApr) changes.push({ date: b.closingDate, what: 'apr', from: `${a.purchaseApr}%`, to: `${b.purchaseApr}%` });
    if (a.creditLine !== null && b.creditLine !== null && a.creditLine !== b.creditLine) changes.push({ date: b.closingDate, what: 'credit_line', from: `$${a.creditLine.toLocaleString('en-US')}`, to: `$${b.creditLine.toLocaleString('en-US')}` });
    if (a.cardName !== b.cardName) changes.push({ date: b.closingDate, what: 'renamed', from: a.cardName, to: b.cardName });
  }

  let paidInFullStreak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].carried < 0.005 && rows[i].interest < 0.005 && rows[i].fees < 0.005; i--) paidInFullStreak++;

  const since12 = addMonths(today, -12);
  const last12 = rows.filter((r) => r.closingDate > since12);
  const last12Net = round2(last12.reduce((s, r) => s + net(r), 0));
  const last12Savings = round2(last12.reduce((s, r) => s + (r.savings ?? 0), 0));
  const lifetimeSavings = round2(years.reduce((s, y) => s + y.savings, 0));
  const lifetimeNet = round2(rows.reduce((s, r) => s + net(r), 0));
  const lifetimePurchases = round2(rows.reduce((s, r) => s + r.purchases, 0));
  const onlineTotal = round2(rows.reduce((s, r) => s + r.online, 0));
  const purchaseTxns = txns.filter((t) => t.kind === 'purchase');
  const thisYear = years.find((y) => String(y.year) === year);
  const expectNext = !!latest && Math.abs(latest.newBalance) >= 0.005;

  return {
    asOf: latest?.closingDate ?? null,
    latest,
    status: !latest ? 'none' : latest.newBalance < -0.005 ? 'credit' : latest.newBalance < 0.005 ? 'paid' : 'due',
    balance: latest?.newBalance ?? 0,
    cardName: lv?.cardName ?? 'Target RedCard',
    creditLine: lv?.creditLine ?? null,
    availableCredit: lv?.availableCredit ?? null,
    utilization: lv?.creditLine ? round2((Math.max(0, lv.newBalance) / lv.creditLine) * 100) : null,
    purchaseApr: lv?.purchaseApr ?? null,
    savingsYtd: thisYear?.savings ?? 0,
    savingsYtdAsOf: thisYear?.savingsAsOf ?? null,
    lifetimeSavings,
    savingsRate: lifetimeNet > 0.005 ? round2((lifetimeSavings / lifetimeNet) * 100) : null,
    rate12: last12Net > 0.005 ? round2((last12Savings / last12Net) * 100) : null,
    last12Net,
    ytdNet: thisYear?.net ?? 0,
    lifetimeNet,
    lifetimePurchases,
    onlineShare: lifetimePurchases > 0.005 ? Math.round((onlineTotal / lifetimePurchases) * 100) : null,
    firstStatement: rows[0]?.closingDate ?? null,
    activeMonths: rows.filter((r) => r.purchases > 0.005).length,
    lastPurchase: purchaseTxns.length ? purchaseTxns.reduce((m, t) => (t.date > m ? t.date : m), purchaseTxns[0].date) : null,
    paidInFullStreak,
    carriedStatements: rows.filter((r) => r.carried >= 0.005 || r.interest >= 0.005).map((r) => r.closingDate),
    lateFees,
    totalFees: round2(years.reduce((s, y) => s + y.fees, 0)),
    totalInterest: round2(years.reduce((s, y) => s + y.interest, 0)),
    charges,
    changes,
    statements: rows,
    years,
    nextStatementExpected: latest ? addMonths(latest.closingDate, 1) : null,
    expectNext,
    nextDue: latest && latest.dueDate && latest.newBalance > 0.005 ? { date: latest.dueDate, amount: latest.newBalance, minimum: latest.minimumPayment } : null,
  };
}

export { isOnline };
