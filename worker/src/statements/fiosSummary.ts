import { round2 } from './common';
import type { StatementCheck } from './common';
import type { FiosItem, FiosValues } from './templates/fios';
import { addMonths } from './adtSummary';

/** Pure summary of the Verizon Fios bills (shared by the derive, the
 * Finance row, the dashboard and Home → Internet). A bill's cost is what it
 * billed for the cycle (current charges); "regular" = the plan, equipment,
 * add-ons, discounts and taxes — without one-time pro-rations or late fees. */

export interface FiosStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // bill date
  values: FiosValues;
  checks: StatementCheck[];
}

export interface FiosTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface FiosBill {
  billDate: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  plan: string | null;
  speedMbps: number | null;
  billed: number; // current charges
  regular: number; // monthlyService + taxes
  taxes: number;
  lateFee: number;
  proration: number;
  discounts: number; // negative
  listPrice: number | null;
  previousBalance: number;
  payments: number;
  totalDue: number;
  dueDate: string | null;
  autopay: boolean;
  autopayDate: string | null;
  pastDue: boolean;
  items: FiosItem[];
  fileId: string;
  checksOk: boolean;
  checks: StatementCheck[];
}

export interface FiosPlanPeriod {
  plan: string;
  speedMbps: number | null;
  from: string; // first bill date on this plan
  to: string; // last bill date on this plan
  bills: number;
  listPrice: number | null;
  regular: number; // regular monthly at the end of the run
}

export interface FiosPricePeriod {
  from: string;
  to: string;
  amount: number;
  bills: number;
}

export interface FiosYear {
  year: number;
  bills: number;
  billed: number;
  paid: number;
  discounts: number;
}

export interface FiosSummary {
  asOf: string | null;
  latest: FiosBill | null;
  plan: string | null;
  speedMbps: number | null;
  monthly: number | null; // latest regular monthly
  listPrice: number | null;
  perGig: number | null; // monthly per 1,000 Mbps
  planSince: string | null;
  priceSince: string | null;
  planHistory: FiosPlanPeriod[];
  priceHistory: FiosPricePeriod[];
  years: FiosYear[];
  ytdBilled: number;
  ytdBills: number;
  lifetimeBilled: number;
  lifetimePaid: number;
  lifetimeDiscounts: number; // positive = saved
  lateFees: number;
  firstBill: string | null;
  bills: FiosBill[];
  gaps: { after: string; before: string; days: number }[];
  pastDueBills: string[];
  addOns: string[];
  equipment: string[];
  priceGuaranteeUntil: string | null;
  /** The $10 Auto-Pay discount: on today, or when it last appeared. */
  autopayDiscount: { active: boolean; amount: number | null; lastSeen: string | null; endedOn: string | null; billsWithout: number; extraPaid: number };
  nextBillExpected: string | null;
  status: 'paid' | 'autopay' | 'due' | 'past_due' | 'credit' | 'none';
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const autopayItem = (items: FiosItem[]) => items.find((i) => i.kind === 'discount' && /auto.?pay/i.test(i.description));

export function summarizeFios(stmts: FiosStmtRow[], txns: FiosTxnRow[], today: string): FiosSummary {
  const bills: FiosBill[] = stmts.map((s) => {
    const v = s.values;
    return {
      billDate: v.billDate,
      servicePeriodStart: v.servicePeriodStart,
      servicePeriodEnd: v.servicePeriodEnd,
      plan: v.plan,
      speedMbps: v.speedMbps,
      billed: v.currentCharges,
      regular: round2(v.monthlyService + v.taxes),
      taxes: v.taxes,
      lateFee: v.lateFee,
      proration: v.proration,
      discounts: v.discounts,
      listPrice: v.listPrice,
      previousBalance: v.previousBalance,
      payments: v.payments,
      totalDue: v.totalDue,
      dueDate: v.dueDate,
      autopay: v.autopay,
      autopayDate: v.autopayDate,
      pastDue: v.pastDue,
      items: v.items,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
      checks: s.checks,
    };
  });
  const latest = bills[bills.length - 1] ?? null;
  const latestValues = stmts[stmts.length - 1]?.values ?? null;

  const planHistory: FiosPlanPeriod[] = [];
  for (const b of bills) {
    if (!b.plan) continue;
    const cur = planHistory[planHistory.length - 1];
    if (cur && cur.plan === b.plan) {
      cur.to = b.billDate;
      cur.bills++;
      cur.regular = b.regular;
      cur.listPrice = b.listPrice ?? cur.listPrice;
    } else {
      planHistory.push({ plan: b.plan, speedMbps: b.speedMbps, from: b.billDate, to: b.billDate, bills: 1, listPrice: b.listPrice, regular: b.regular });
    }
  }

  // Price runs on the regular monthly; a bill with a pro-ration (a plan
  // change mid-cycle) still carries the new regular charges.
  const priceHistory: FiosPricePeriod[] = [];
  for (const b of bills) {
    const cur = priceHistory[priceHistory.length - 1];
    if (cur && Math.abs(cur.amount - b.regular) < 0.005) {
      cur.to = b.billDate;
      cur.bills++;
    } else {
      priceHistory.push({ from: b.billDate, to: b.billDate, amount: b.regular, bills: 1 });
    }
  }
  // Fold one-bill blips (a one-month add-on) back into their run.
  for (let i = priceHistory.length - 2; i >= 1; i--) {
    const a = priceHistory[i - 1], blip = priceHistory[i], c = priceHistory[i + 1];
    if (blip.bills === 1 && Math.abs(a.amount - c.amount) < 0.005) {
      a.to = c.to;
      a.bills += blip.bills + c.bills;
      priceHistory.splice(i, 2);
    }
  }

  const byYear = new Map<number, FiosYear>();
  for (const b of bills) {
    const y = Number(b.billDate.slice(0, 4));
    const row = byYear.get(y) ?? { year: y, bills: 0, billed: 0, paid: 0, discounts: 0 };
    row.bills++;
    row.billed = round2(row.billed + b.billed);
    row.discounts = round2(row.discounts - b.discounts);
    byYear.set(y, row);
  }
  for (const t of txns) {
    if (t.kind !== 'payment') continue;
    const y = Number(t.date.slice(0, 4));
    const row = byYear.get(y) ?? { year: y, bills: 0, billed: 0, paid: 0, discounts: 0 };
    row.paid = round2(row.paid - t.amount);
    byYear.set(y, row);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  const thisYear = byYear.get(Number(today.slice(0, 4)));

  const gaps: FiosSummary['gaps'] = [];
  for (let i = 1; i < bills.length; i++) {
    const d = daysBetween(bills[i - 1].billDate, bills[i].billDate);
    if (d > 45) gaps.push({ after: bills[i - 1].billDate, before: bills[i].billDate, days: d });
  }

  // Auto-Pay discount: last bill that carried it.
  let lastWith = -1;
  bills.forEach((b, i) => {
    if (autopayItem(b.items)) lastWith = i;
  });
  const active = lastWith >= 0 && lastWith === bills.length - 1;
  const discountAmount = lastWith >= 0 ? Math.abs(autopayItem(bills[lastWith].items)!.amount) : null;
  const without = lastWith >= 0 && !active ? bills.slice(lastWith + 1) : [];

  let status: FiosSummary['status'] = 'none';
  if (latest) {
    if (latest.totalDue < -0.005) status = 'credit';
    else if (latest.pastDue || (latest.previousBalance > 0.005 && round2(latest.previousBalance + latest.payments) > 0.005)) status = 'past_due';
    else if (latest.totalDue <= 0.005) status = 'paid';
    else if (latest.autopay) status = 'autopay';
    else status = 'due';
  }
  const curPlan = planHistory[planHistory.length - 1] ?? null;
  const monthly = latest ? latest.regular : null;

  return {
    asOf: latest?.billDate ?? null,
    latest,
    plan: curPlan?.plan ?? null,
    speedMbps: curPlan?.speedMbps ?? null,
    monthly,
    listPrice: latest?.listPrice ?? null,
    perGig: monthly !== null && curPlan?.speedMbps ? round2((monthly / curPlan.speedMbps) * 1000) : null,
    planSince: curPlan?.from ?? null,
    priceSince: priceHistory[priceHistory.length - 1]?.from ?? null,
    planHistory,
    priceHistory,
    years,
    ytdBilled: thisYear?.billed ?? 0,
    ytdBills: thisYear?.bills ?? 0,
    lifetimeBilled: round2(bills.reduce((s, b) => s + b.billed, 0)),
    lifetimePaid: round2(-txns.filter((t) => t.kind === 'payment').reduce((s, t) => s + t.amount, 0)),
    lifetimeDiscounts: round2(-bills.reduce((s, b) => s + b.discounts, 0)),
    lateFees: round2(bills.reduce((s, b) => s + b.lateFee, 0)),
    firstBill: bills[0]?.billDate ?? null,
    bills,
    gaps,
    pastDueBills: bills.filter((b) => b.pastDue).map((b) => b.billDate),
    addOns: latestValues?.addOns ?? [],
    equipment: latestValues?.equipment ?? [],
    priceGuaranteeUntil: latestValues?.priceGuaranteeUntil ?? null,
    autopayDiscount: {
      active,
      amount: discountAmount,
      lastSeen: lastWith >= 0 ? bills[lastWith].billDate : null,
      endedOn: without[0]?.billDate ?? null,
      billsWithout: without.length,
      extraPaid: round2((discountAmount ?? 0) * without.filter((b) => b.autopay).length),
    },
    nextBillExpected: latest ? addMonths(latest.billDate, 1) : null,
    status,
  };
}
