import { round2 } from './common';
import type { StatementCheck } from './common';
import { addMonths } from './adtSummary';
import { tmobileLineName } from './templates/tmobile';
import type { TmobileValues } from './templates/tmobile';

/** Pure summary of the T-Mobile bills (shared by the derive, the Finance
 * row and the dashboard). A bill's cost is its THIS BILL SUMMARY Totals row
 * (taxes are already inside T-Mobile's prices); Total Due also carries any
 * balance from the month before. */

export interface TmobileStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // bill date
  values: TmobileValues;
  checks: StatementCheck[];
}

export interface TmobileTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
}

export interface TmobileBill {
  billDate: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  plans: number;
  equipment: number;
  services: number;
  oneTime: number;
  billed: number; // this bill's charges (Totals row)
  balance: number; // carried in from last month
  previousBalance: number | null;
  totalDue: number;
  dueDate: string | null;
  dueNote: string | null;
  autopay: boolean;
  autopayCard: string | null;
  plan: string | null;
  lines: number; // lines on the bill (not removed)
  dataGb: number | null;
  minutes: number | null;
  messages: number | null;
  savings: number | null;
  lateFee: number | null;
  fileId: string;
  checksOk: boolean;
  checks: StatementCheck[];
}

export interface TmobileLineSummary {
  number: string;
  name: string; // Mike · Wife · Wearable Line …
  type: string | null;
  firstBill: string;
  lastBill: string;
  active: boolean; // on the latest bill and not removed
  status: string | null; // latest status on the bill ("Removed", "New", …)
  /** Latest bill: the line's own charges + an even share of the account plan
   * charge across the voice lines whose plan is "Included". */
  planShare: number;
  ownCharges: number;
  monthly: number;
  latestDataGb: number | null;
  avgDataGb12: number | null;
  ownLifetime: number; // the line's own charges (plans/equipment/services/one-time) over every bill
  device: string | null; // latest device on an installment plan for this line
}

export interface TmobileDeviceSummary {
  id: string;
  line: string | null;
  lineName: string | null;
  device: string;
  firstBill: string;
  lastBill: string;
  installment: number | null;
  of: number | null;
  balance: number | null;
  monthlyCharge: number; // latest installment charged
  monthlyCredit: number; // latest promo credit against it (negative)
  paidOff: boolean;
  payoffExpected: string | null; // bill date of the last installment
  active: boolean; // still on the latest bill
}

export interface TmobilePlanPeriod {
  from: string;
  to: string;
  plan: string | null;
  plans: number; // the Plans column (account plan + any extra line plans)
  lines: number;
  bills: number;
}

export interface TmobileYear {
  year: number;
  bills: number;
  billed: number;
  paid: number;
  plans: number;
  equipment: number;
  services: number;
  oneTime: number;
  dataGb: number;
}

export interface TmobileSummary {
  asOf: string | null;
  latest: TmobileBill | null;
  monthly: number | null; // latest bill's charges
  usualMonthly: number | null; // median of the last 6 bills' charges
  plan: string | null;
  planCharge: number | null; // latest Plans column
  planSince: string | null;
  planHistory: TmobilePlanPeriod[];
  lines: TmobileLineSummary[];
  devices: TmobileDeviceSummary[];
  devicePayments: number; // equipment still owed (sum of active balances)
  years: TmobileYear[];
  ytdBilled: number;
  ytdBills: number;
  lifetimeBilled: number;
  lifetimePaid: number;
  lifetimeSavings: number;
  lifetimeEquipment: number;
  firstBill: string | null;
  bills: TmobileBill[];
  gaps: { after: string; before: string; days: number }[];
  pastDueBills: string[];
  lateFees: { date: string; amount: number }[];
  nextBillExpected: string | null;
  status: 'paid' | 'autopay' | 'due' | 'past_due' | 'credit' | 'none';
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};
const isRemoved = (status: string | null) => !!status && /removed|cancel/i.test(status);

/** Carried in unpaid (a positive balance printed as PAST DUE, or a
 * previous balance that wasn't paid off). Credits carried forward are fine. */
export const carriedUnpaid = (v: TmobileValues) => v.balance > 0.005;

export function summarizeTmobile(stmts: TmobileStmtRow[], txns: TmobileTxnRow[], today: string): TmobileSummary {
  const bills: TmobileBill[] = stmts.map((s) => {
    const v = s.values;
    return {
      billDate: v.billDate,
      servicePeriodStart: v.servicePeriodStart,
      servicePeriodEnd: v.servicePeriodEnd,
      plans: v.plans,
      equipment: v.equipment,
      services: v.services,
      oneTime: v.oneTime,
      billed: v.charges,
      balance: v.balance,
      previousBalance: v.previousBalance,
      totalDue: v.totalDue,
      dueDate: v.dueDate,
      dueNote: v.dueNote,
      autopay: v.autopay,
      autopayCard: v.autopayCard,
      plan: v.plan,
      lines: v.lines.filter((l) => !isRemoved(l.status)).length,
      dataGb: v.dataGb,
      minutes: v.minutes,
      messages: v.messages,
      savings: v.savings,
      lateFee: v.lateFee ?? null,
      fileId: s.fileId,
      checksOk: s.checks.every((c) => c.ok),
      checks: s.checks,
    };
  });
  const latest = bills[bills.length - 1] ?? null;
  const latestV = stmts[stmts.length - 1]?.values ?? null;

  // ---- Plan history: runs of the same plan name + account plan charge ----
  // (the Account row of THIS BILL SUMMARY — extra line plans like a watch
  // are per-line costs, not the plan). One-bill blips between two equal runs
  // (a lost AutoPay discount, a pro-rated month) fold into the run.
  const acctPlanOf = (i: number) => stmts[i].values.accountRow?.plans ?? bills[i].plans;
  const runs: TmobilePlanPeriod[] = [];
  bills.forEach((b, i) => {
    const cur = runs[runs.length - 1];
    const price = acctPlanOf(i);
    if (cur && cur.plan === b.plan && Math.abs(cur.plans - price) < 0.005) {
      cur.to = b.billDate;
      cur.bills++;
      cur.lines = b.lines;
    } else {
      runs.push({ from: b.billDate, to: b.billDate, plan: b.plan, plans: price, lines: b.lines, bills: 1 });
    }
  });
  const planHistory: TmobilePlanPeriod[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const prev = planHistory[planHistory.length - 1];
    const next = runs[i + 1];
    if (r.bills === 1 && prev && next && prev.plan === next.plan && Math.abs(prev.plans - next.plans) < 0.005) {
      prev.to = next.to;
      prev.bills += r.bills + next.bills;
      prev.lines = next.lines;
      i++;
      continue;
    }
    if (prev && prev.plan === r.plan && Math.abs(prev.plans - r.plans) < 0.005) {
      prev.to = r.to;
      prev.bills += r.bills;
      prev.lines = r.lines;
      continue;
    }
    planHistory.push({ ...r });
  }
  // Since when has the current plan name + price held (ignoring line-count
  // blips like a one-month DIGITS line)?
  let planSince: string | null = null;
  if (latest) {
    planSince = latest.billDate;
    const acctPlans = (i: number) => stmts[i].values.accountRow?.plans ?? bills[i].plans;
    const want = acctPlans(bills.length - 1);
    for (let i = bills.length - 1; i >= 0; i--) {
      if (bills[i].plan !== latest.plan || Math.abs(acctPlans(i) - want) > 0.005) break;
      planSince = bills[i].billDate;
    }
  }

  // ---- Lines ----
  const lineMap = new Map<string, TmobileLineSummary & { dataPoints: { date: string; gb: number }[] }>();
  for (const s of stmts) {
    for (const l of s.values.lines) {
      const cur = lineMap.get(l.digits);
      const own = round2(l.plans + l.equipment + l.services + l.oneTime);
      if (!cur) {
        lineMap.set(l.digits, {
          number: l.number,
          name: tmobileLineName(l.number, l.type),
          type: l.type,
          firstBill: s.periodEnd,
          lastBill: s.periodEnd,
          active: false,
          status: l.status,
          planShare: 0,
          ownCharges: 0,
          monthly: 0,
          latestDataGb: null,
          avgDataGb12: null,
          ownLifetime: own,
          device: null,
          dataPoints: l.dataGb !== null ? [{ date: s.periodEnd, gb: l.dataGb }] : [],
        });
      } else {
        cur.lastBill = s.periodEnd;
        cur.status = l.status;
        if (l.type) cur.type = l.type;
        cur.ownLifetime = round2(cur.ownLifetime + own);
        if (l.dataGb !== null) cur.dataPoints.push({ date: s.periodEnd, gb: l.dataGb });
      }
    }
  }
  const latestLines = latestV?.lines ?? [];
  const sharers = latestLines.filter((l) => l.planIncluded && !isRemoved(l.status));
  const acctPlan = latestV?.accountRow ? round2(latestV.accountRow.plans + latestV.accountRow.services + latestV.accountRow.oneTime) : 0;
  const share = sharers.length ? round2(acctPlan / sharers.length) : 0;
  const yearAgo = latest ? addMonths(latest.billDate, -12) : '';
  const lines: TmobileLineSummary[] = [...lineMap.values()].map((l) => {
    const onLatest = latestLines.find((x) => x.digits === l.number.replace(/\D/g, ''));
    const own = onLatest ? round2(onLatest.plans + onLatest.equipment + onLatest.services + onLatest.oneTime) : 0;
    const planShare = onLatest && sharers.includes(onLatest) ? share : 0;
    const recent = l.dataPoints.filter((p) => p.date > yearAgo);
    const { dataPoints: _dp, ...rest } = l;
    void _dp;
    return {
      ...rest,
      name: tmobileLineName(l.number, l.type),
      active: !!onLatest && !isRemoved(onLatest.status),
      planShare,
      ownCharges: own,
      monthly: round2(planShare + own),
      latestDataGb: onLatest?.dataGb ?? null,
      avgDataGb12: recent.length ? round2(recent.reduce((a, p) => a + p.gb, 0) / recent.length) : null,
    };
  });

  // ---- Devices (installment plans, keyed by plan id) ----
  const devMap = new Map<string, TmobileDeviceSummary>();
  for (const s of stmts) {
    for (const d of s.values.devices) {
      const cur = devMap.get(d.id);
      const promo = round2(s.values.promos.filter((p) => p.id === d.id).reduce((a, p) => a + p.amount, 0));
      const row: TmobileDeviceSummary = {
        id: d.id,
        line: d.line ?? cur?.line ?? null,
        lineName: d.line ? tmobileLineName(d.line) : cur?.lineName ?? null,
        // Keep the fullest name seen ("Pixel Fold - Obsidian" over "Pixel Fold").
        device: cur && cur.device.length > d.device.length && cur.device.startsWith(d.device) ? cur.device : d.device,
        firstBill: cur?.firstBill ?? s.periodEnd,
        lastBill: s.periodEnd,
        installment: d.installment ?? cur?.installment ?? null,
        of: d.of ?? cur?.of ?? null,
        balance: d.balance ?? cur?.balance ?? null,
        monthlyCharge: d.charge,
        monthlyCredit: promo,
        paidOff: d.completed,
        payoffExpected: null,
        active: false,
      };
      devMap.set(d.id, row);
    }
  }
  const devices = [...devMap.values()].map((d) => {
    const onLatest = !!latestV?.devices.some((x) => x.id === d.id);
    const left = d.installment !== null && d.of !== null ? d.of - d.installment : null;
    // Gone from the latest bill = paid off (or paid off early with an upgrade / trade-in).
    const paidOff = d.paidOff || (d.balance !== null && d.balance <= 0.005) || !onLatest;
    const ln = d.line ? lineMap.get(d.line.replace(/\D/g, '')) : undefined;
    return {
      ...d,
      lineName: d.line ? tmobileLineName(d.line, ln?.type ?? null) : null,
      paidOff,
      active: onLatest && !paidOff,
      payoffExpected: !paidOff && left !== null ? addMonths(d.lastBill, left) : null,
    };
  });
  devices.sort((a, b) => (a.active === b.active ? b.lastBill.localeCompare(a.lastBill) : a.active ? -1 : 1));
  for (const l of lines) {
    const dev = devices.find((d) => d.active && d.line === l.number) ?? devices.find((d) => d.line === l.number && d.lastBill === l.lastBill);
    l.device = dev?.device ?? null;
  }
  lines.sort((a, b) => (a.active === b.active ? (TMOBILE_ORDER(a) - TMOBILE_ORDER(b) || a.firstBill.localeCompare(b.firstBill)) : a.active ? -1 : 1));

  // ---- Years ----
  const byYear = new Map<number, TmobileYear>();
  const yearRow = (y: number) => byYear.get(y) ?? { year: y, bills: 0, billed: 0, paid: 0, plans: 0, equipment: 0, services: 0, oneTime: 0, dataGb: 0 };
  for (const b of bills) {
    const y = Number(b.billDate.slice(0, 4));
    const row = yearRow(y);
    row.bills++;
    row.billed = round2(row.billed + b.billed);
    row.plans = round2(row.plans + b.plans);
    row.equipment = round2(row.equipment + b.equipment);
    row.services = round2(row.services + b.services);
    row.oneTime = round2(row.oneTime + b.oneTime);
    row.dataGb = round2(row.dataGb + (b.dataGb ?? 0));
    byYear.set(y, row);
  }
  for (const t of txns) {
    if (t.kind !== 'payment') continue;
    const y = Number(t.date.slice(0, 4));
    const row = yearRow(y);
    row.paid = round2(row.paid - t.amount);
    byYear.set(y, row);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  const thisYear = byYear.get(Number(today.slice(0, 4)));

  const gaps: TmobileSummary['gaps'] = [];
  for (let i = 1; i < bills.length; i++) {
    const d = daysBetween(bills[i - 1].billDate, bills[i].billDate);
    if (d > 45) gaps.push({ after: bills[i - 1].billDate, before: bills[i].billDate, days: d });
  }

  let status: TmobileSummary['status'] = 'none';
  if (latest && latestV) {
    if (latest.totalDue < -0.005) status = 'credit';
    else if (carriedUnpaid(latestV)) status = 'past_due';
    else if (latest.totalDue <= 0.005) status = 'paid';
    else if (latest.autopay) status = 'autopay';
    else status = 'due';
  }

  return {
    asOf: latest?.billDate ?? null,
    latest,
    monthly: latest?.billed ?? null,
    usualMonthly: median(bills.slice(-6).map((b) => b.billed)),
    plan: latest?.plan ?? null,
    planCharge: latestV ? (latestV.accountRow?.plans ?? latestV.plans) : null,
    planSince,
    planHistory,
    lines,
    devices,
    devicePayments: round2(devices.filter((d) => d.active).reduce((a, d) => a + (d.balance ?? 0), 0)),
    years,
    ytdBilled: thisYear?.billed ?? 0,
    ytdBills: thisYear?.bills ?? 0,
    lifetimeBilled: round2(bills.reduce((s, b) => s + b.billed, 0)),
    lifetimePaid: round2(-txns.filter((t) => t.kind === 'payment').reduce((s, t) => s + t.amount, 0)),
    lifetimeSavings: round2(bills.reduce((s, b) => s + (b.savings ?? 0), 0)),
    lifetimeEquipment: round2(bills.reduce((s, b) => s + b.equipment, 0)),
    firstBill: bills[0]?.billDate ?? null,
    bills,
    gaps,
    pastDueBills: stmts.filter((s) => carriedUnpaid(s.values)).map((s) => s.periodEnd),
    lateFees: bills.filter((b) => b.lateFee).map((b) => ({ date: b.billDate, amount: b.lateFee! })),
    nextBillExpected: latest ? addMonths(latest.billDate, 1) : null,
    status,
  };
}

/** Named lines first (Mike, then Wife), then the rest. */
function TMOBILE_ORDER(l: { name: string }): number {
  return l.name === 'Mike' ? 0 : l.name === 'Wife' ? 1 : 2;
}
