import { round2 } from './common';
import type { StatementCheck } from './common';
import type { AmazonValues } from './templates/amazon';
import { addMonths } from './adtSummary';

/** Pure summary of the Amazon Prime Visa statements (shared by the derive,
 * the Finance row and the dashboard). Money owed is positive; a "carried"
 * statement is one whose previous balance wasn't paid off during the
 * period (that's when interest starts). Points are Chase's: 100 points =
 * $1, so their cash value is points / 100. */

export interface AmazonStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string; // closing date
  values: AmazonValues;
  checks: StatementCheck[];
}

export interface AmazonTxnRow {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface AmazonStatementRow {
  closingDate: string;
  openingDate: string;
  previousBalance: number;
  paid: number;
  credits: number; // refunds + reward credits + statement credits
  purchases: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  carried: number; // previous balance left unpaid during the period (0 = paid in full)
  pointsEarned: number | null;
  pointsTotal: number | null;
  fileId: string;
  checksOk: boolean;
}

export interface AmazonYear {
  year: number;
  statements: number;
  purchases: number;
  refunds: number;
  net: number; // purchases − refunds
  amazon: number; // net spend at Amazon / Whole Foods
  pointsEarned: number;
  interest: number;
  fees: number;
}

export interface AmazonMonth {
  closingDate: string;
  purchases: number;
  net: number;
  balance: number;
}

export interface AmazonPointsPoint {
  closingDate: string;
  total: number;
  earned: number;
  redeemed: number;
}

export interface AmazonCategory {
  category: string;
  points: number;
  last12: number;
}

export interface AmazonMerchant {
  merchant: string;
  amount: number;
  count: number;
}

export interface AmazonCharge {
  date: string;
  description: string;
  kind: 'fee' | 'interest' | 'credit';
  amount: number;
}

export interface AmazonChange {
  date: string; // closing date of the statement that first shows it
  what: 'apr' | 'credit_line' | 'cash_line' | 'rewards';
  from: string;
  to: string;
}

export interface AmazonSummary {
  asOf: string | null;
  latest: AmazonStatementRow | null;
  status: 'paid' | 'due' | 'past_due' | 'credit' | 'none';
  balance: number;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null; // percent of the credit line in use at closing
  purchaseApr: number | null;
  pointsBalance: number | null;
  pointsValue: number | null; // $
  pointsAsOf: string | null;
  lifetimePointsEarned: number;
  lifetimePointsRedeemed: number;
  rewardCredits: number; // $ of points applied to the balance (REDEMPTION CREDIT)
  shopWithPoints: number; // $ of Amazon orders paid with points at checkout
  rewardRate: number | null; // points earned ÷ net purchases (percent), last 12 statements
  ytdPurchases: number;
  ytdNet: number;
  ytdPointsEarned: number;
  last12Net: number;
  last12Amazon: number;
  avgMonthlyNet: number | null; // last 12 statements
  lifetimeNet: number;
  firstStatement: string | null;
  paidInFullStreak: number; // consecutive latest statements paid in full and on time
  carriedStatements: string[]; // closing dates of statements that carried a balance
  totalInterest: number;
  totalFees: number;
  totalStatementCredits: number;
  charges: AmazonCharge[]; // every fee, interest charge and statement credit
  changes: AmazonChange[];
  statements: AmazonStatementRow[];
  years: AmazonYear[];
  months: AmazonMonth[];
  points: AmazonPointsPoint[];
  categories: AmazonCategory[];
  topMerchants: AmazonMerchant[]; // last 12 months
  nextStatementExpected: string | null;
  nextDue: { date: string; amount: number; minimum: number } | null;
}

const isAmazon = (d: string) => /^(AMAZON|AMZN|Amazon\.com|PrimePantry|Prime Video|Audible|Kindle)/i.test(d) || /WHOLEFDS|WHOLE FOODS/i.test(d);

/** "AMAZON MKTPL*5A84M2GP1 Amzn.com/bill WA · Order 113-…" → "Amazon";
 * "DUANE READE #14123 NEW YORK NY" → "Duane Reade"; "AMZ*WSJ support@wsj.c NJ" → "WSJ". */
export function merchantOf(description: string): string {
  let d = description.replace(/ · Order .*$/, '').trim();
  if (/WHOLEFDS|WHOLE FOODS/i.test(d)) return 'Whole Foods';
  if (/^AMZ\*/i.test(d)) d = d.slice(4); // Amazon Pay: the merchant follows
  else if (isAmazon(d)) return 'Amazon';
  else d = d.split(/[#*]/)[0];
  const words = d.trim().split(/\s+/);
  if (words.length > 1 && /^[A-Z]{2}$/.test(words[words.length - 1])) words.pop(); // state
  while (words.length > 1 && /[./@]|\d{3,}|-$/.test(words[words.length - 1])) words.pop(); // site, phone, store no.
  return title(words.join(' ')) || description;
}
const title = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bCvs\b/, 'CVS')
    .trim();

/** "+ 5% back on Amazon.com purchases" → "Amazon". Null = not earned:
 * the 2017 product-change transfer, and points handed back when a Shop
 * With Points order is refunded ("Points adjusted for refund"). */
export function categoryOf(label: string): string | null {
  if (/transferred from other product/i.test(label)) return null;
  if (/adjusted for refund/i.test(label)) return null;
  if (/bonus/i.test(label)) return 'Bonuses';
  const m = label.match(/% back (?:on|at) (.+)$/i);
  if (!m) return label;
  const c = m[1].toLowerCase();
  if (/amazon/.test(c)) return 'Amazon';
  if (/whole foods/.test(c)) return 'Whole Foods';
  if (/gas/.test(c)) return 'Gas Stations';
  if (/restaurant/.test(c)) return 'Restaurants';
  if (/drugstore/.test(c)) return 'Drugstores';
  if (/office/.test(c)) return 'Office Supply';
  if (/travel/.test(c)) return 'Chase Travel';
  if (/transit|commut/.test(c)) return 'Transit';
  if (/all other/.test(c)) return 'Everything Else';
  return title(m[1]);
}

export function summarizeAmazon(stmts: AmazonStmtRow[], txns: AmazonTxnRow[], today: string): AmazonSummary {
  const rows: AmazonStatementRow[] = stmts.map((s) => {
    const v = s.values;
    const earned = v.points ? v.points.earned.filter((e) => categoryOf(e.label) !== null).reduce((a, e) => a + e.points, 0) : null;
    return {
      closingDate: v.closingDate,
      openingDate: v.openingDate,
      previousBalance: v.previousBalance,
      paid: v.paid,
      credits: round2(v.refunds + v.rewardCredits + v.statementCredits),
      purchases: round2(v.purchases + v.cashAdvances + v.balanceTransfers),
      fees: v.fees,
      interest: v.interest,
      newBalance: v.newBalance,
      minimumPayment: v.minimumPayment,
      dueDate: v.dueDate,
      carried: Math.max(0, round2(v.previousBalance + v.paymentsCredits)),
      pointsEarned: earned,
      pointsTotal: v.points?.total ?? null,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
    };
  });
  const latest = rows[rows.length - 1] ?? null;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const year = today.slice(0, 4);
  const last12 = stmts.slice(-12);
  const netOf = (v: AmazonValues) => round2(v.purchases - v.refunds);

  // ---- Years ----
  const byYear = new Map<number, AmazonYear>();
  for (const s of stmts) {
    const y = Number(s.periodEnd.slice(0, 4));
    const cur = byYear.get(y) ?? { year: y, statements: 0, purchases: 0, refunds: 0, net: 0, amazon: 0, pointsEarned: 0, interest: 0, fees: 0 };
    const v = s.values;
    cur.statements++;
    cur.purchases = round2(cur.purchases + v.purchases);
    cur.refunds = round2(cur.refunds + v.refunds);
    cur.net = round2(cur.purchases - cur.refunds);
    cur.interest = round2(cur.interest + v.interest);
    cur.fees = round2(cur.fees + v.fees);
    cur.pointsEarned += rows.find((r) => r.closingDate === v.closingDate)?.pointsEarned ?? 0;
    byYear.set(y, cur);
  }
  // Amazon share of spend comes from the activity rows, counted in the
  // year of the statement they posted on (like the statement totals).
  const yearOfStmt = new Map(stmts.map((x) => [x.id, Number(x.periodEnd.slice(0, 4))]));
  const spend = txns.filter((t) => t.kind === 'purchase' || t.kind === 'refund');
  for (const t of spend) {
    if (!isAmazon(t.description)) continue;
    const y = byYear.get((t.statementId && yearOfStmt.get(t.statementId)) || Number(t.date.slice(0, 4)));
    if (y) y.amazon = round2(y.amazon + t.amount);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  // ---- Points ----
  const points: AmazonPointsPoint[] = stmts
    .filter((s) => s.values.points)
    .map((s) => ({ closingDate: s.periodEnd, total: s.values.points!.total, earned: rows.find((r) => r.closingDate === s.periodEnd)?.pointsEarned ?? 0, redeemed: s.values.points!.redeemed }));
  const catMap = new Map<string, AmazonCategory>();
  const last12Ends = new Set(last12.map((s) => s.periodEnd));
  for (const s of stmts) {
    for (const e of s.values.points?.earned ?? []) {
      const c = categoryOf(e.label);
      if (!c) continue;
      const cur = catMap.get(c) ?? { category: c, points: 0, last12: 0 };
      cur.points += e.points;
      if (last12Ends.has(s.periodEnd)) cur.last12 += e.points;
      catMap.set(c, cur);
    }
  }
  const categories = [...catMap.values()].filter((c) => c.points !== 0).sort((a, b) => b.points - a.points);
  const lifetimePointsEarned = points.reduce((s, p) => s + p.earned, 0);
  const last12Points = last12.reduce((s, x) => s + (rows.find((r) => r.closingDate === x.periodEnd)?.pointsEarned ?? 0), 0);
  const last12Net = round2(last12.reduce((s, x) => s + netOf(x.values), 0));

  // ---- Merchants (last 12 months of activity) ----
  const since = latest ? addMonths(latest.closingDate, -12) : '';
  const merch = new Map<string, AmazonMerchant>();
  for (const t of spend) {
    if (t.date <= since) continue;
    const m = merchantOf(t.description);
    const cur = merch.get(m) ?? { merchant: m, amount: 0, count: 0 };
    cur.amount = round2(cur.amount + t.amount);
    if (t.kind === 'purchase') cur.count++;
    merch.set(m, cur);
  }
  const topMerchants = [...merch.values()].filter((m) => m.amount > 0.005).sort((a, b) => b.amount - a.amount).slice(0, 10);
  const last12Amazon = round2(spend.filter((t) => t.date > since && isAmazon(t.description)).reduce((s, t) => s + t.amount, 0));

  // ---- Fees, interest, credits ----
  const charges: AmazonCharge[] = txns
    .filter((t) => t.kind === 'fee' || t.kind === 'interest' || t.kind === 'adjustment')
    .map((t) => ({ date: t.date, description: t.description, kind: t.kind === 'adjustment' ? ('credit' as const) : (t.kind as 'fee' | 'interest'), amount: t.amount }));

  // ---- Term changes ----
  const changes: AmazonChange[] = [];
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    if (a.apr.purchases !== null && b.apr.purchases !== null && a.apr.purchases !== b.apr.purchases) changes.push({ date: b.closingDate, what: 'apr', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    if (a.creditLine !== null && b.creditLine !== null && a.creditLine !== b.creditLine) changes.push({ date: b.closingDate, what: 'credit_line', from: `$${a.creditLine.toLocaleString('en-US')}`, to: `$${b.creditLine.toLocaleString('en-US')}` });
    if (a.cashLine !== null && b.cashLine !== null && a.cashLine !== b.cashLine) changes.push({ date: b.closingDate, what: 'cash_line', from: `$${a.cashLine.toLocaleString('en-US')}`, to: `$${b.cashLine.toLocaleString('en-US')}` });
    const topRate = (v: AmazonValues) => Math.max(0, ...(v.points?.earned ?? []).filter((e) => /amazon/i.test(e.label) && e.rate !== null).map((e) => e.rate!));
    if (a.points && b.points && topRate(a) && topRate(b) && topRate(a) !== topRate(b)) changes.push({ date: b.closingDate, what: 'rewards', from: `${topRate(a)}% at Amazon`, to: `${topRate(b)}% at Amazon` });
  }

  let paidInFullStreak = 0;
  // Paid in full AND on time: nothing carried, no interest, no late fee.
  for (let i = rows.length - 1; i >= 0 && rows[i].carried < 0.005 && rows[i].interest < 0.005 && rows[i].fees < 0.005; i--) paidInFullStreak++;

  const status: AmazonSummary['status'] = !latest
    ? 'none'
    : (lv?.pastDue ?? 0) > 0.005
      ? 'past_due'
      : latest.newBalance < -0.005
        ? 'credit'
        : latest.newBalance < 0.005
          ? 'paid'
          : 'due';

  return {
    asOf: latest?.closingDate ?? null,
    latest,
    status,
    balance: latest?.newBalance ?? 0,
    creditLine: lv?.creditLine ?? null,
    availableCredit: lv?.availableCredit ?? null,
    utilization: lv?.creditLine ? round2((Math.max(0, lv.newBalance) / lv.creditLine) * 100) : null,
    purchaseApr: lv?.apr.purchases ?? null,
    pointsBalance: lv?.points?.total ?? null,
    pointsValue: lv?.points ? round2(lv.points.total / 100) : null,
    pointsAsOf: lv?.points ? lv.closingDate : null,
    lifetimePointsEarned,
    lifetimePointsRedeemed: points.reduce((s, p) => s + p.redeemed, 0),
    rewardCredits: round2(stmts.reduce((s, x) => s + x.values.rewardCredits, 0)),
    shopWithPoints: round2(stmts.reduce((s, x) => s + (x.values.shopWithPoints ?? []).reduce((a, r) => a + r.amount, 0), 0)),
    rewardRate: last12Net > 0 ? round2(last12Points / last12Net) : null, // points/$ ÷ 100 × 100 = percent
    ytdPurchases: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + x.values.purchases, 0)),
    ytdNet: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + netOf(x.values), 0)),
    ytdPointsEarned: rows.filter((r) => r.closingDate.startsWith(year)).reduce((s, r) => s + (r.pointsEarned ?? 0), 0),
    last12Net,
    last12Amazon,
    avgMonthlyNet: last12.length ? round2(last12Net / last12.length) : null,
    lifetimeNet: round2(stmts.reduce((s, x) => s + netOf(x.values), 0)),
    firstStatement: stmts[0]?.periodEnd ?? null,
    paidInFullStreak,
    carriedStatements: rows.filter((r) => r.carried >= 0.005 || r.interest >= 0.005).map((r) => r.closingDate),
    totalInterest: round2(stmts.reduce((s, x) => s + x.values.interest, 0)),
    totalFees: round2(stmts.reduce((s, x) => s + x.values.fees, 0)),
    totalStatementCredits: round2(stmts.reduce((s, x) => s + x.values.statementCredits, 0)),
    charges,
    changes,
    statements: rows,
    years,
    months: stmts.map((s) => ({ closingDate: s.periodEnd, purchases: s.values.purchases, net: netOf(s.values), balance: s.values.newBalance })),
    points,
    categories,
    topMerchants,
    nextStatementExpected: latest ? addMonths(latest.closingDate, 1) : null,
    nextDue: latest && latest.dueDate && latest.newBalance > 0.005 ? { date: latest.dueDate, amount: latest.newBalance, minimum: latest.minimumPayment } : null,
  };
}
