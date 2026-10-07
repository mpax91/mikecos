import { round2 } from './common';
import type { StatementCheck } from './common';
import type { AdtValues } from './templates/adt';

/** Pure summary of the ADT bills (shared by the derive, the Finance row and
 * the dashboard). A bill's cost is what it billed for the period — current
 * charges + taxes — not its "Total Due", which also carries any unpaid
 * previous balance. */

export interface AdtStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // invoice date
  values: AdtValues;
  checks: StatementCheck[];
}

export interface AdtTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface AdtBill {
  invoiceDate: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  charges: number;
  taxes: number;
  billed: number; // charges + taxes
  previousBalance: number;
  payments: number; // payments & adjustments printed on this bill (negative = paid)
  totalDue: number;
  dueDate: string | null;
  dueNote: string | null;
  autopay: boolean;
  monthlyRate: number | null;
  services: string | null;
  fileId: string;
  checksOk: boolean;
  checks: StatementCheck[];
}

export interface AdtRatePeriod {
  from: string; // first invoice date at this rate
  to: string; // last invoice date at this rate
  rate: number;
  services: string | null;
  bills: number;
}

export interface AdtYear {
  year: number;
  bills: number;
  billed: number;
  paid: number;
}

export interface AdtSummary {
  asOf: string | null;
  latest: AdtBill | null;
  monthlyRate: number | null;
  monthlyWithTax: number | null; // latest full-month rate incl. its tax share
  rateSince: string | null;
  rateHistory: AdtRatePeriod[];
  years: AdtYear[];
  ytdBilled: number;
  ytdBills: number;
  lifetimeBilled: number;
  lifetimePaid: number;
  firstInvoice: string | null;
  bills: AdtBill[];
  gaps: { after: string; before: string; days: number }[];
  pastDueBills: string[]; // invoice dates printed "Past Due" or carrying an unpaid balance
  nextBillExpected: string | null;
  status: 'paid' | 'autopay' | 'due' | 'past_due' | 'credit' | 'none';
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
export function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** A bill whose previous balance wasn't paid during the period. */
export const unpaidCarry = (v: AdtValues) => v.previousBalance > 0.005 && round2(v.previousBalance + v.paymentsAdjustments) > 0.005;

export function summarizeAdt(stmts: AdtStmtRow[], txns: AdtTxnRow[], today: string): AdtSummary {
  const bills: AdtBill[] = stmts.map((s) => {
    const v = s.values;
    return {
      invoiceDate: v.invoiceDate,
      servicePeriodStart: v.servicePeriodStart,
      servicePeriodEnd: v.servicePeriodEnd,
      charges: v.currentCharges,
      taxes: v.taxesFees,
      billed: round2(v.currentCharges + v.taxesFees),
      previousBalance: v.previousBalance,
      payments: v.paymentsAdjustments,
      totalDue: v.totalDue,
      dueDate: v.dueDate,
      dueNote: v.dueNote,
      autopay: v.autopay,
      monthlyRate: v.monthlyRate,
      services: v.services,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
      checks: s.checks,
    };
  });
  const latest = bills[bills.length - 1] ?? null;

  // Rate history: runs of the same full-month recurring charge. Bills with
  // no full-month line (credits, pro-rations) don't break a run.
  const rateHistory: AdtRatePeriod[] = [];
  for (const b of bills) {
    if (b.monthlyRate === null || b.monthlyRate <= 0) continue;
    const cur = rateHistory[rateHistory.length - 1];
    if (cur && Math.abs(cur.rate - b.monthlyRate) < 0.005) {
      cur.to = b.invoiceDate;
      cur.bills++;
      if (b.services) cur.services = b.services;
    } else {
      rateHistory.push({ from: b.invoiceDate, to: b.invoiceDate, rate: b.monthlyRate, services: b.services, bills: 1 });
    }
  }
  const curRate = rateHistory[rateHistory.length - 1] ?? null;
  const rateBill = [...bills].reverse().find((b) => b.monthlyRate !== null && curRate && Math.abs(b.monthlyRate - curRate.rate) < 0.005 && Math.abs(b.charges - b.monthlyRate) < 0.005);
  const monthlyWithTax = rateBill ? round2(rateBill.charges + rateBill.taxes) : null;

  const byYear = new Map<number, AdtYear>();
  for (const b of bills) {
    const y = Number(b.invoiceDate.slice(0, 4));
    const row = byYear.get(y) ?? { year: y, bills: 0, billed: 0, paid: 0 };
    row.bills++;
    row.billed = round2(row.billed + b.billed);
    byYear.set(y, row);
  }
  for (const t of txns) {
    if (t.kind !== 'payment') continue;
    const y = Number(t.date.slice(0, 4));
    const row = byYear.get(y) ?? { year: y, bills: 0, billed: 0, paid: 0 };
    row.paid = round2(row.paid - t.amount);
    byYear.set(y, row);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  const thisYear = byYear.get(Number(today.slice(0, 4)));

  const gaps: AdtSummary['gaps'] = [];
  for (let i = 1; i < bills.length; i++) {
    const d = daysBetween(bills[i - 1].invoiceDate, bills[i].invoiceDate);
    if (d > 45) gaps.push({ after: bills[i - 1].invoiceDate, before: bills[i].invoiceDate, days: d });
  }

  let status: AdtSummary['status'] = 'none';
  if (latest) {
    if (latest.totalDue < -0.005) status = 'credit';
    else if (latest.dueNote === 'Past Due' || unpaidCarry(stmts[stmts.length - 1].values)) status = 'past_due';
    else if (latest.totalDue <= 0.005) status = 'paid';
    else if (latest.autopay) status = 'autopay';
    else status = 'due';
  }

  return {
    asOf: latest?.invoiceDate ?? null,
    latest,
    monthlyRate: curRate?.rate ?? null,
    monthlyWithTax,
    rateSince: curRate?.from ?? null,
    rateHistory,
    years,
    ytdBilled: thisYear?.billed ?? 0,
    ytdBills: thisYear?.bills ?? 0,
    lifetimeBilled: round2(bills.reduce((s, b) => s + b.billed, 0)),
    lifetimePaid: round2(-txns.filter((t) => t.kind === 'payment').reduce((s, t) => s + t.amount, 0)),
    firstInvoice: bills[0]?.invoiceDate ?? null,
    bills,
    gaps,
    pastDueBills: bills.filter((b, i) => b.dueNote === 'Past Due' || unpaidCarry(stmts[i].values)).map((b) => b.invoiceDate),
    nextBillExpected: latest ? addMonths(latest.invoiceDate, 1) : null,
    status,
  };
}
