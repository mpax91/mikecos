import { round2 } from './common';
import type { StatementCheck } from './common';
import type { BofaCardValues } from './templates/bofaCard';
import { addMonths } from './adtSummary';
import { amexMerchantOf } from './amexCardSummary';

/** Pure summary of the Bank of America cash-back card statements (shared
 * by the derive, the Finance row and the dashboard). Money owed is
 * positive; a "carried" statement is one whose previous balance wasn't
 * paid off during the period. Cash back is exact: each statement prints
 * what it earned (base + category bonus + relationship bonus), what was
 * redeemed and the balance available. Bank of America sends no statement
 * for a month with no activity and a $0 balance, so a gap between two $0
 * statements is "quiet", not missing. */

export interface BofaCardStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string; // closing date
  values: BofaCardValues;
  checks: StatementCheck[];
}

export interface BofaCardTxnRow {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface BofaCardStatementRow {
  closingDate: string;
  openingDate: string;
  previousBalance: number;
  paid: number;
  credits: number; // refunds + cash back redeemed as a statement credit
  purchases: number; // Purchases and Adjustments
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  carried: number; // previous balance left unpaid during the period (0 = paid in full)
  apr: number | null;
  cashBackAvailable: number | null;
  cashBackEarned: number | null; // this statement (exact)
  cashBackRedeemed: number | null;
  /** Cash back earned on statements missing from Drive since the previous
   * one (an estimate from the balance change; 0 for quiet months). */
  cashBackBridged: number;
  /** Cash back that left between two statements without a statement credit
   * (redeemed to a bank account during months with no statement). */
  cashBackGapRedeemed: number;
  autopay: boolean | null;
  fileId: string;
  checksOk: boolean;
}

export interface BofaCardYear {
  year: number;
  statements: number;
  purchases: number;
  refunds: number;
  net: number; // purchases − refunds
  cashBackEarned: number;
  base: number;
  bonus: number;
  relationship: number;
  interest: number;
  fees: number;
  /** Fees / interest the year-to-date totals show beyond the rows read —
   * charged on a statement missing from Drive. */
  hiddenFees?: number;
  hiddenInterest?: number;
  estimated: boolean; // includes a bridged (estimated) month
}

export interface BofaCardMerchant {
  merchant: string;
  amount: number;
  count: number;
}

export interface BofaCardCharge {
  date: string;
  description: string;
  kind: 'fee' | 'interest' | 'credit';
  amount: number;
}

export interface BofaCardChange {
  date: string;
  what: 'apr' | 'credit_line' | 'cash_line' | 'penalty_on' | 'penalty_off';
  from: string;
  to: string;
}

export interface BofaGaps {
  missing: string[]; // YYYY-MM with no statement where one was expected
  quiet: string[]; // YYYY-MM between two $0 statements (no statement issued)
}

export interface BofaCardSummary {
  asOf: string | null;
  latest: BofaCardStatementRow | null;
  status: 'paid' | 'due' | 'past_due' | 'credit' | 'none';
  balance: number;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null;
  purchaseApr: number | null;
  penaltyApr: number | null;
  onPenaltyApr: boolean;
  cardType: string | null;
  cashBackAvailable: number | null;
  cashBackAsOf: string | null;
  lifetimeCashBackEarned: number;
  lifetimeCashBackRedeemed: number;
  lifetimeBridged: number; // part of the lifetime figure that's estimated
  ytdCashBackEarned: number;
  rewardRate: number | null; // cash back earned ÷ net purchases (percent), last 12 statements
  ytdPurchases: number;
  ytdNet: number;
  last12Net: number;
  avgMonthlyNet: number | null;
  lifetimeNet: number;
  firstStatement: string | null;
  paidInFullStreak: number;
  carriedStatements: string[];
  lateFees: { date: string; amount: number }[];
  totalInterest: number;
  totalFees: number;
  autopayShare: number | null; // % of payments (last 12 statements with one) made by BofA AutoPay
  latestPaymentAutopay: boolean | null;
  charges: BofaCardCharge[];
  changes: BofaCardChange[];
  statements: BofaCardStatementRow[];
  years: BofaCardYear[];
  months: { closingDate: string; purchases: number; net: number; balance: number }[];
  cashBack: { asOf: string; available: number; earned: number }[];
  topMerchants: BofaCardMerchant[]; // last 12 months
  nextStatementExpected: string | null;
  nextDue: { date: string; amount: number; minimum: number } | null;
}

/** Bank of America descriptions: "DECICCO FAMILY MAR KATONAH NY",
 * "CVS PHARMACY #1949 Q03 LARCHMONT NY", "SQSP* INV159885836 …" →
 * "Decicco Family Mar", "Cvs Pharmacy", "Squarespace". */
export function bofaMerchantOf(description: string): string {
  const d = description.trim();
  if (/^SQSP\*/i.test(d)) return 'Squarespace';
  if (/^(BA ELECTRONIC PAYMENT|ONLINE\/MOBILE PAYMENT|PAYMENT)/i.test(d)) return 'Payment';
  return amexMerchantOf(d.replace(/^(TST|SQ|SP|PY|PP|DD|IC)\*\s*/i, ''));
}

const ym = (iso: string) => iso.slice(0, 7);

/** Months between the first and the last statement with no statement.
 * Duplicate / skipped files don't cover their month (a mis-named copy of
 * another statement leaves its own month missing); an unreadable file is
 * flagged on its own, so its month isn't a gap. A gap between a $0 closing
 * balance and a $0 previous balance is quiet. */
export function bofaGaps(stmts: BofaCardStmtRow[], files: { file_name: string; status: string }[]): BofaGaps {
  const out: BofaGaps = { missing: [], quiet: [] };
  if (stmts.length < 2) return out;
  const have = new Set(stmts.map((s) => ym(s.periodEnd)));
  for (const f of files) {
    if (f.status === 'skipped' || f.status === 'duplicate' || f.status === 'parsed') continue;
    const m = f.file_name.match(/(\d{4})\.(\d{2})/);
    if (m) have.add(`${m[1]}-${m[2]}`);
  }
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1], b = stmts[i];
    const months: string[] = [];
    for (let d = addMonths(a.periodEnd, 1); ym(d) < ym(b.periodEnd); d = addMonths(d, 1)) if (!have.has(ym(d))) months.push(ym(d));
    if (!months.length) continue;
    // Cash back can still move in a quiet month (redeemed to a bank account
    // shows on no card statement), so only the card balance decides.
    const quiet = Math.abs(a.values.newBalance) < 0.005 && Math.abs(b.values.previousBalance) < 0.005;
    (quiet ? out.quiet : out.missing).push(...months);
  }
  return out;
}

export function summarizeBofaCard(stmts: BofaCardStmtRow[], txns: BofaCardTxnRow[], today: string): BofaCardSummary {
  const rows: BofaCardStatementRow[] = stmts.map((s, i) => {
    const v = s.values;
    const prev = i ? stmts[i - 1].values : null;
    const consecutive = !!prev && ym(addMonths(prev.closingDate, 1)) === ym(v.closingDate);
    let bridged = 0;
    let gapRedeemed = 0;
    if (prev && !consecutive && prev.rewards && v.rewards) {
      // Available at the start of this statement vs at the previous one.
      const delta = round2(v.rewards.available - v.rewards.earned + v.rewards.redeemed - prev.rewards.available);
      bridged = Math.max(0, delta);
      gapRedeemed = Math.max(0, -delta);
    }
    return {
      closingDate: v.closingDate,
      openingDate: v.openingDate,
      previousBalance: v.previousBalance,
      paid: v.paid,
      credits: round2(v.refunds + v.rewardCredits),
      purchases: v.purchasesAdjustments,
      fees: v.fees,
      interest: v.interest,
      newBalance: v.newBalance,
      minimumPayment: v.minimumPayment,
      dueDate: v.dueDate,
      carried: Math.max(0, round2(v.previousBalance + v.paymentsCredits)),
      apr: v.apr.purchases,
      cashBackAvailable: v.rewards?.available ?? null,
      cashBackEarned: v.rewards?.earned ?? null,
      cashBackRedeemed: v.rewards?.redeemed ?? null,
      cashBackBridged: bridged,
      cashBackGapRedeemed: gapRedeemed,
      autopay: v.autopay,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
    };
  });
  const latest = rows[rows.length - 1] ?? null;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const year = today.slice(0, 4);
  const last12 = rows.slice(-12);
  const netOf = (v: BofaCardValues) => round2(v.purchases - v.refunds);
  const earnedOf = (r: BofaCardStatementRow) => (r.cashBackEarned ?? 0) + r.cashBackBridged;

  // ---- Years ----
  const byYear = new Map<number, BofaCardYear>();
  stmts.forEach((s, i) => {
    const y = Number(s.periodEnd.slice(0, 4));
    const cur = byYear.get(y) ?? { year: y, statements: 0, purchases: 0, refunds: 0, net: 0, cashBackEarned: 0, base: 0, bonus: 0, relationship: 0, interest: 0, fees: 0, estimated: false };
    const v = s.values;
    cur.statements++;
    cur.purchases = round2(cur.purchases + v.purchases);
    cur.refunds = round2(cur.refunds + v.refunds);
    cur.net = round2(cur.purchases - cur.refunds);
    cur.interest = round2(cur.interest + v.interest);
    cur.fees = round2(cur.fees + v.fees);
    cur.cashBackEarned = round2(cur.cashBackEarned + earnedOf(rows[i]));
    cur.base = round2(cur.base + (v.rewards?.base ?? 0));
    cur.bonus = round2(cur.bonus + (v.rewards?.bonus ?? 0));
    cur.relationship = round2(cur.relationship + (v.rewards?.relationship ?? 0));
    // A statement missing from Drive just before this one (not a quiet
    // no-activity month) — its cash back is only known as a net change.
    const prev = i ? stmts[i - 1].values : null;
    const gapBefore = !!prev && ym(addMonths(prev.closingDate, 1)) !== ym(v.closingDate) && !(Math.abs(prev.newBalance) < 0.005 && Math.abs(v.previousBalance) < 0.005);
    if (rows[i].cashBackBridged > 0.005 || !v.rewards || gapBefore) cur.estimated = true;
    byYear.set(y, cur);
  });
  // Each statement also prints "Total fees/interest charged in YYYY" — a fee
  // on a statement missing from Drive still shows up there (2022's late fee).
  for (const y of byYear.values()) {
    const inYear = stmts.filter((x) => x.values.ytdYear === y.year);
    const feesYtd = Math.max(0, ...inYear.map((x) => x.values.feesYtd ?? 0));
    const intYtd = Math.max(0, ...inYear.map((x) => x.values.interestYtd ?? 0));
    if (feesYtd > y.fees + 0.005) {
      y.hiddenFees = round2(feesYtd - y.fees);
      y.fees = round2(feesYtd);
    }
    if (intYtd > y.interest + 0.005) {
      y.hiddenInterest = round2(intYtd - y.interest);
      y.interest = round2(intYtd);
    }
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  // ---- Merchants (last 12 months of activity) ----
  const since = latest ? addMonths(latest.closingDate, -12) : '';
  const merch = new Map<string, BofaCardMerchant>();
  for (const t of txns) {
    if ((t.kind !== 'purchase' && t.kind !== 'refund') || t.date <= since) continue;
    const m = bofaMerchantOf(t.description);
    const cur = merch.get(m) ?? { merchant: m, amount: 0, count: 0 };
    cur.amount = round2(cur.amount + t.amount);
    if (t.kind === 'purchase') cur.count++;
    merch.set(m, cur);
  }
  const topMerchants = [...merch.values()].filter((m) => m.amount > 0.005).sort((a, b) => b.amount - a.amount).slice(0, 10);

  // ---- Fees, interest, credits ----
  const charges: BofaCardCharge[] = txns
    .filter((t) => t.kind === 'fee' || t.kind === 'interest' || t.kind === 'adjustment')
    .map((t) => ({ date: t.date, description: t.description, kind: t.kind === 'adjustment' ? ('credit' as const) : (t.kind as 'fee' | 'interest'), amount: t.amount }));
  const lateFees = txns.filter((t) => t.kind === 'fee' && /late/i.test(t.description)).map((t) => ({ date: t.date, amount: t.amount }));

  // ---- Term changes ----
  const penaltyApr = [...stmts].reverse().find((s) => s.values.penaltyApr !== null)?.values.penaltyApr ?? null;
  const isPenalty = (v: BofaCardValues) => v.apr.purchases !== null && penaltyApr !== null && v.apr.purchases >= penaltyApr;
  const changes: BofaCardChange[] = [];
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    const pa = isPenalty(a), pb = isPenalty(b);
    if (!pa && pb) changes.push({ date: b.closingDate, what: 'penalty_on', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    else if (pa && !pb) changes.push({ date: b.closingDate, what: 'penalty_off', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    else if (a.apr.purchases !== null && b.apr.purchases !== null && a.apr.purchases !== b.apr.purchases) changes.push({ date: b.closingDate, what: 'apr', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    if (a.creditLine !== null && b.creditLine !== null && a.creditLine !== b.creditLine) changes.push({ date: b.closingDate, what: 'credit_line', from: `$${a.creditLine.toLocaleString('en-US')}`, to: `$${b.creditLine.toLocaleString('en-US')}` });
    if (a.cashLine !== null && b.cashLine !== null && a.cashLine !== b.cashLine) changes.push({ date: b.closingDate, what: 'cash_line', from: `$${a.cashLine.toLocaleString('en-US')}`, to: `$${b.cashLine.toLocaleString('en-US')}` });
  }

  // Paid in full AND on time, counting back to a statement missing from
  // Drive (what happened on it is unknown — 2022's YTD totals show a late fee).
  let paidInFullStreak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].carried < 0.005 && rows[i].interest < 0.005 && rows[i].fees < 0.005; i--) {
    paidInFullStreak++;
    const prev = i ? stmts[i - 1].values : null;
    const v = stmts[i].values;
    if (prev && ym(addMonths(prev.closingDate, 1)) !== ym(v.closingDate) && !(Math.abs(prev.newBalance) < 0.005 && Math.abs(v.previousBalance) < 0.005)) break;
  }

  const withPayment = rows.filter((r) => r.autopay !== null).slice(-12);
  const latestPay = [...rows].reverse().find((r) => r.autopay !== null);
  const last12Earned = round2(last12.reduce((s, r) => s + earnedOf(r), 0));
  const last12Net = round2(stmts.slice(-12).reduce((s, x) => s + netOf(x.values), 0));
  const status: BofaCardSummary['status'] = !latest ? 'none' : latest.newBalance < -0.005 ? 'credit' : latest.newBalance < 0.005 ? 'paid' : 'due';
  const lastRewards = [...stmts].reverse().find((s) => s.values.rewards);

  return {
    asOf: latest?.closingDate ?? null,
    latest,
    status,
    balance: latest?.newBalance ?? 0,
    creditLine: lv?.creditLine ?? null,
    availableCredit: lv?.availableCredit ?? null,
    utilization: lv?.creditLine ? round2((Math.max(0, lv.newBalance) / lv.creditLine) * 100) : null,
    purchaseApr: lv?.apr.purchases ?? null,
    penaltyApr,
    onPenaltyApr: lv ? isPenalty(lv) : false,
    cardType: [...stmts].reverse().find((s) => s.values.cardType)?.values.cardType ?? null,
    cashBackAvailable: lastRewards?.values.rewards?.available ?? null,
    cashBackAsOf: lastRewards?.periodEnd ?? null,
    lifetimeCashBackEarned: round2(rows.reduce((s, r) => s + earnedOf(r), 0)),
    lifetimeCashBackRedeemed: round2(rows.reduce((s, r) => s + (r.cashBackRedeemed ?? 0) + r.cashBackGapRedeemed, 0)),
    lifetimeBridged: round2(rows.reduce((s, r) => s + r.cashBackBridged, 0)),
    ytdCashBackEarned: round2(rows.filter((r) => r.closingDate.startsWith(year)).reduce((s, r) => s + earnedOf(r), 0)),
    rewardRate: last12Net > 0 ? round2((last12Earned / last12Net) * 100) : null,
    ytdPurchases: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + x.values.purchases, 0)),
    ytdNet: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + netOf(x.values), 0)),
    last12Net,
    avgMonthlyNet: last12.length ? round2(last12Net / last12.length) : null,
    lifetimeNet: round2(stmts.reduce((s, x) => s + netOf(x.values), 0)),
    firstStatement: stmts[0]?.periodEnd ?? null,
    paidInFullStreak,
    carriedStatements: rows.filter((r) => r.carried >= 0.005 || r.interest >= 0.005).map((r) => r.closingDate),
    lateFees,
    totalInterest: round2(years.reduce((s, y) => s + y.interest, 0)),
    totalFees: round2(years.reduce((s, y) => s + y.fees, 0)),
    autopayShare: withPayment.length ? Math.round((withPayment.filter((r) => r.autopay).length / withPayment.length) * 100) : null,
    latestPaymentAutopay: latestPay ? latestPay.autopay : null,
    charges,
    changes,
    statements: rows,
    years,
    months: stmts.map((s) => ({ closingDate: s.periodEnd, purchases: s.values.purchasesAdjustments, net: netOf(s.values), balance: s.values.newBalance })),
    cashBack: stmts.filter((s) => s.values.rewards).map((s) => ({ asOf: s.periodEnd, available: s.values.rewards!.available, earned: s.values.rewards!.earned })),
    topMerchants,
    nextStatementExpected: latest ? addMonths(latest.closingDate, 1) : null,
    nextDue: latest && latest.dueDate && latest.newBalance > 0.005 && latest.minimumPayment > 0.005 ? { date: latest.dueDate, amount: latest.newBalance, minimum: latest.minimumPayment } : null,
  };
}
