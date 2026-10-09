import { round2 } from './common';
import type { StatementCheck } from './common';
import type { AmexCardValues } from './templates/amexCard';
import { addMonths } from './adtSummary';

/** Pure summary of the Amex Blue Cash Everyday statements (shared by the
 * derive, the Finance row and the dashboard). Money owed is positive; a
 * "carried" statement is one whose previous balance wasn't paid off during
 * the period. Rewards are Amex "Reward Dollars" (cash back, $1 = $1): the
 * statement prints the balance as of the PREVIOUS closing, so cash back
 * earned between two snapshots = the change in balance + whatever was
 * redeemed in between ("YOUR CASH REWARD/REFUND IS" credits). */

export interface AmexCardStmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string; // closing date
  values: AmexCardValues;
  checks: StatementCheck[];
}

export interface AmexCardTxnRow {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface AmexCardStatementRow {
  closingDate: string;
  openingDate: string;
  previousBalance: number;
  paid: number;
  credits: number; // refunds + reward dollars redeemed
  purchases: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  carried: number; // previous balance left unpaid during the period (0 = paid in full)
  apr: number | null;
  rewardDollars: number | null; // balance printed on this statement (as of the previous closing)
  rewardsEarned: number | null; // cash back earned since the previous snapshot (null = no chain)
  rewardsBridged: boolean; // the previous month's statement is missing — rewardsEarned spans the gap (an estimate)
  fileId: string;
  checksOk: boolean;
}

export interface AmexCardYear {
  year: number;
  statements: number;
  purchases: number;
  refunds: number;
  net: number; // purchases − refunds
  rewardsEarned: number;
  interest: number;
  fees: number;
}

export interface AmexCardMerchant {
  merchant: string;
  amount: number;
  count: number;
}

export interface AmexCardCharge {
  date: string;
  description: string;
  kind: 'fee' | 'interest' | 'credit';
  amount: number;
}

export interface AmexCardChange {
  date: string; // closing date of the statement that first shows it
  what: 'apr' | 'credit_line' | 'cash_line' | 'penalty_on' | 'penalty_off';
  from: string;
  to: string;
}

export interface AmexCardSummary {
  asOf: string | null;
  latest: AmexCardStatementRow | null;
  status: 'paid' | 'due' | 'past_due' | 'credit' | 'none';
  balance: number;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null;
  purchaseApr: number | null;
  penaltyApr: number | null; // the card's penalty rate (printed in the late-payment warning)
  onPenaltyApr: boolean; // the latest purchase APR is the penalty rate
  rewardDollars: number | null;
  rewardDollarsAsOf: string | null;
  lifetimeRewardsEarned: number;
  lifetimeRewardsRedeemed: number;
  ytdRewardsEarned: number;
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
  charges: AmexCardCharge[];
  changes: AmexCardChange[];
  statements: AmexCardStatementRow[];
  years: AmexCardYear[];
  months: { closingDate: string; purchases: number; net: number; balance: number }[];
  rewards: { asOf: string; balance: number }[];
  topMerchants: AmexCardMerchant[]; // last 12 months
  nextStatementExpected: string | null;
  nextDue: { date: string; amount: number; minimum: number } | null;
}

const title = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^([^a-z]*)([a-z])/, (_, a, c) => a + c.toUpperCase()))
    .join(' ')
    .trim();

/** Amex prints merchant, store/terminal number and city run together:
 * "DECICCO FAMILY MARKETS 2 452944 KATONAH NY" → "Decicco Family Markets";
 * "STOP & SHOP 2596 MOUNT KISCO NY" → "Stop & Shop"; "GOOGLE *GOOGLE ONE
 * G.CO/HELPPAY# CA" → "Google One". Up to three words, cut at the first
 * store number / web address. */
export function amexMerchantOf(description: string): string {
  let d = description
    .trim()
    .replace(/^GglPay /i, '')
    .replace(/ GOOGLE PAYMENT\b/i, '')
    .replace(/^(SP|SQ|TST|PY|PP) ?\*?\s+(?=\S)/, ''); // Shopify / Square / Toast / PayPal processor prefixes
  let prefix = '';
  const g = d.match(/^GOOGLE ?\*(.*)$/i);
  if (g) {
    d = g[1].trim();
    if (!/^GOOGLE\b/i.test(d)) prefix = 'Google · ';
  }
  const words = d.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (/\d{3,}|[./#*]|^\d+-\d/.test(w)) break;
    out.push(w);
    if (out.length === 3) break;
  }
  while (out.length > 1 && /^(\d{1,2}|[A-Z]{2})$/.test(out[out.length - 1]) && out.length === words.length) out.pop(); // state
  while (out.length > 1 && /^\d{1,2}$/.test(out[out.length - 1])) out.pop();
  return prefix + (title(out.join(' ')) || description);
}

export function summarizeAmexCard(stmts: AmexCardStmtRow[], txns: AmexCardTxnRow[], today: string): AmexCardSummary {
  // ---- Reward dollars: earned between consecutive snapshots ----
  const redemptions = txns.filter((t) => t.kind === 'reward');
  const earnedAt = new Map<string, number>(); // closing date → earned since previous snapshot
  const bridged = new Set<string>();
  let prevSnap: { asOf: string; balance: number } | null = null;
  for (let i = 0; i < stmts.length; i++) {
    const v = stmts[i].values;
    if (v.rewardDollars === null || !v.rewardDollarsAsOf) {
      prevSnap = null;
      continue;
    }
    const snap = { asOf: v.rewardDollarsAsOf, balance: v.rewardDollars };
    const consecutive = i > 0 && addMonths(stmts[i - 1].periodEnd, 1).slice(0, 7) === v.closingDate.slice(0, 7);
    if (prevSnap) {
      // Across missing months the change in balance still counts; only a
      // redemption printed on a missing statement goes unseen (estimate).
      const redeemed = -redemptions.filter((t) => t.date > prevSnap!.asOf && t.date <= snap.asOf).reduce((s, t) => s + t.amount, 0);
      earnedAt.set(v.closingDate, round2(Math.max(0, snap.balance - prevSnap.balance + redeemed)));
      if (!consecutive) bridged.add(v.closingDate);
    }
    prevSnap = snap;
  }

  const rows: AmexCardStatementRow[] = stmts.map((s) => {
    const v = s.values;
    return {
      closingDate: v.closingDate,
      openingDate: v.openingDate,
      previousBalance: v.previousBalance,
      paid: v.paid,
      credits: round2(v.refunds + v.rewardCredits),
      purchases: v.newCharges,
      fees: v.fees,
      interest: v.interest,
      newBalance: v.newBalance,
      minimumPayment: v.minimumPayment,
      dueDate: v.dueDate,
      carried: Math.max(0, round2(v.previousBalance + v.paymentsCredits)),
      apr: v.apr.purchases,
      rewardDollars: v.rewardDollars,
      rewardsEarned: earnedAt.get(v.closingDate) ?? null,
      rewardsBridged: bridged.has(v.closingDate),
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
    };
  });
  const latest = rows[rows.length - 1] ?? null;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const year = today.slice(0, 4);
  const last12 = rows.slice(-12);
  const netOf = (v: AmexCardValues) => round2(v.newCharges - v.refunds);

  // ---- Years ----
  const byYear = new Map<number, AmexCardYear>();
  for (const s of stmts) {
    const y = Number(s.periodEnd.slice(0, 4));
    const cur = byYear.get(y) ?? { year: y, statements: 0, purchases: 0, refunds: 0, net: 0, rewardsEarned: 0, interest: 0, fees: 0 };
    const v = s.values;
    cur.statements++;
    cur.purchases = round2(cur.purchases + v.newCharges);
    cur.refunds = round2(cur.refunds + v.refunds);
    cur.net = round2(cur.purchases - cur.refunds);
    cur.interest = round2(cur.interest + v.interest);
    cur.fees = round2(cur.fees + v.fees);
    cur.rewardsEarned = round2(cur.rewardsEarned + (earnedAt.get(v.closingDate) ?? 0));
    byYear.set(y, cur);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  // ---- Merchants (last 12 months of activity) ----
  const since = latest ? addMonths(latest.closingDate, -12) : '';
  const spend = txns.filter((t) => t.kind === 'purchase' || t.kind === 'refund');
  const merch = new Map<string, AmexCardMerchant>();
  for (const t of spend) {
    if (t.date <= since) continue;
    const m = amexMerchantOf(t.description);
    const cur = merch.get(m) ?? { merchant: m, amount: 0, count: 0 };
    cur.amount = round2(cur.amount + t.amount);
    if (t.kind === 'purchase') cur.count++;
    merch.set(m, cur);
  }
  const topMerchants = [...merch.values()].filter((m) => m.amount > 0.005).sort((a, b) => b.amount - a.amount).slice(0, 10);

  // ---- Fees, interest, credits ----
  const charges: AmexCardCharge[] = txns
    .filter((t) => t.kind === 'fee' || t.kind === 'interest' || t.kind === 'adjustment')
    .map((t) => ({ date: t.date, description: t.description, kind: t.kind === 'adjustment' ? ('credit' as const) : (t.kind as 'fee' | 'interest'), amount: t.amount }));
  const lateFees = txns.filter((t) => t.kind === 'fee' && /late/i.test(t.description)).map((t) => ({ date: t.date, amount: t.amount }));

  // ---- Term changes ----
  const penaltyApr = [...stmts].reverse().find((s) => s.values.penaltyApr !== null)?.values.penaltyApr ?? null;
  const isPenalty = (v: AmexCardValues) => v.apr.purchases !== null && v.penaltyApr !== null && v.apr.purchases >= v.penaltyApr;
  const changes: AmexCardChange[] = [];
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    const pa = isPenalty(a), pb = isPenalty(b);
    if (!pa && pb) changes.push({ date: b.closingDate, what: 'penalty_on', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    else if (pa && !pb) changes.push({ date: b.closingDate, what: 'penalty_off', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    else if (a.apr.purchases !== null && b.apr.purchases !== null && a.apr.purchases !== b.apr.purchases) changes.push({ date: b.closingDate, what: 'apr', from: `${a.apr.purchases}%`, to: `${b.apr.purchases}%` });
    if (a.creditLine !== null && b.creditLine !== null && a.creditLine !== b.creditLine) changes.push({ date: b.closingDate, what: 'credit_line', from: `$${a.creditLine.toLocaleString('en-US')}`, to: `$${b.creditLine.toLocaleString('en-US')}` });
    if (a.cashLine !== null && b.cashLine !== null && a.cashLine !== b.cashLine) changes.push({ date: b.closingDate, what: 'cash_line', from: `$${a.cashLine.toLocaleString('en-US')}`, to: `$${b.cashLine.toLocaleString('en-US')}` });
  }

  let paidInFullStreak = 0;
  // Paid in full AND on time: nothing carried, no interest, no late fee.
  for (let i = rows.length - 1; i >= 0 && rows[i].carried < 0.005 && rows[i].interest < 0.005 && rows[i].fees < 0.005; i--) paidInFullStreak++;

  const last12Earned = round2(last12.reduce((s, r) => s + (r.rewardsEarned ?? 0), 0));
  const last12Net = round2(stmts.slice(-12).reduce((s, x) => s + netOf(x.values), 0));
  const status: AmexCardSummary['status'] = !latest ? 'none' : latest.newBalance < -0.005 ? 'credit' : latest.newBalance < 0.005 ? 'paid' : 'due';

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
    rewardDollars: [...stmts].reverse().find((s) => s.values.rewardDollars !== null)?.values.rewardDollars ?? null,
    rewardDollarsAsOf: [...stmts].reverse().find((s) => s.values.rewardDollars !== null)?.values.rewardDollarsAsOf ?? null,
    lifetimeRewardsEarned: round2(rows.reduce((s, r) => s + (r.rewardsEarned ?? 0), 0) + (stmts.find((s) => s.values.rewardDollars !== null)?.values.rewardDollars ?? 0)),
    lifetimeRewardsRedeemed: round2(-redemptions.reduce((s, t) => s + t.amount, 0)),
    ytdRewardsEarned: round2(rows.filter((r) => r.closingDate.startsWith(year)).reduce((s, r) => s + (r.rewardsEarned ?? 0), 0)),
    rewardRate: last12Net > 0 && last12.some((r) => r.rewardsEarned !== null) ? round2((last12Earned / last12Net) * 100) : null,
    ytdPurchases: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + x.values.newCharges, 0)),
    ytdNet: round2(stmts.filter((s) => s.periodEnd.startsWith(year)).reduce((s, x) => s + netOf(x.values), 0)),
    last12Net,
    avgMonthlyNet: last12.length ? round2(last12Net / last12.length) : null,
    lifetimeNet: round2(stmts.reduce((s, x) => s + netOf(x.values), 0)),
    firstStatement: stmts[0]?.periodEnd ?? null,
    paidInFullStreak,
    carriedStatements: rows.filter((r) => r.carried >= 0.005 || r.interest >= 0.005).map((r) => r.closingDate),
    lateFees,
    totalInterest: round2(stmts.reduce((s, x) => s + x.values.interest, 0)),
    totalFees: round2(stmts.reduce((s, x) => s + x.values.fees, 0)),
    charges,
    changes,
    statements: rows,
    years,
    months: stmts.map((s) => ({ closingDate: s.periodEnd, purchases: s.values.newCharges, net: netOf(s.values), balance: s.values.newBalance })),
    rewards: stmts.filter((s) => s.values.rewardDollars !== null && s.values.rewardDollarsAsOf).map((s) => ({ asOf: s.values.rewardDollarsAsOf!, balance: s.values.rewardDollars! })),
    topMerchants,
    nextStatementExpected: latest ? addMonths(latest.closingDate, 1) : null,
    nextDue: latest && latest.dueDate && latest.newBalance > 0.005 ? { date: latest.dueDate, amount: latest.newBalance, minimum: latest.minimumPayment } : null,
  };
}
