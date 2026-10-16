import { round2 } from './common';
import type { StatementCheck } from './common';
import type { HanoverActivity, HanoverBillValues, HanoverLine, HanoverPolicyValues, HanoverScheduleRow, HanoverValues, HanoverVehicle } from './templates/hanover';

/** Hanover Insurance summary (computed on read, nothing stored): what each
 * policy costs now and how it got there, how it's paid (Auto-Pay withdrawals
 * from the billing notices; a policy that never appears on a notice — the
 * home — is paid through the mortgage escrow), every withdrawal past and
 * scheduled, term-over-term premiums for renewal trends, and the change log. */

export interface HanoverStmtRow {
  id: string;
  fileId: string;
  periodEnd: string;
  values: HanoverValues;
  checks: StatementCheck[];
}

export interface HanoverPayment {
  date: string;
  total: number;
  /** Premium per line in this withdrawal (fee excluded). */
  byLine: Partial<Record<HanoverLine, number>>;
  fee: number;
  status: 'withdrawn' | 'scheduled';
  /** Statement date of the notice this amount comes from. */
  notice: string;
}

export interface HanoverPremiumPoint {
  effective: string;
  premium: number;
  prevPremium: number | null;
  reason: string;
  amended: boolean;
  fileId: string;
}

export interface HanoverPolicy {
  line: HanoverLine;
  label: string;
  policyNumber: string;
  termStart: string;
  termEnd: string;
  premium: number;
  /** Premium when this term started (first declarations of the term). */
  termStartPremium: number;
  paidVia: 'autopay' | 'escrow' | 'bill';
  history: HanoverPremiumPoint[];
  current: HanoverPolicyValues;
}

export interface HanoverTerm {
  termStart: string;
  termEnd: string;
  /** Premium at the start of the term and where it ended (or is now). */
  start: Partial<Record<HanoverLine, number>>;
  end: Partial<Record<HanoverLine, number>>;
  startTotal: number;
  endTotal: number;
}

export interface HanoverChange {
  date: string;
  line: HanoverLine | null;
  description: string;
  /** Premium change for the year (declarations) or the pro-rated amount billed (notice). */
  amount: number | null;
  /** What the change added to (or took off) the remaining installments — the notice's pro-rated amount. */
  billed?: number;
  source: 'declarations' | 'notice';
}

export interface HanoverSummary {
  asOf: string | null;
  customer: string | null;
  last4: string | null;
  autopay: boolean | null;
  installmentFee: number | null;
  termStart: string | null;
  termEnd: string | null;
  renewsInDays: number | null;
  policies: HanoverPolicy[];
  annualPremium: number;
  /** Auto + umbrella: what the withdrawals pay. */
  billedPremium: number;
  /** Home: paid by the mortgage escrow. */
  escrowPremium: number;
  vehicles: HanoverVehicle[];
  payments: HanoverPayment[];
  next: HanoverPayment | null;
  last: HanoverPayment | null;
  paidThisTerm: number;
  feesThisTerm: number;
  remainingThisTerm: number;
  terms: HanoverTerm[];
  /** Renewal declarations already in the folder for a term that hasn't started yet. */
  upcoming: HanoverTerm | null;
  years: { year: number; withdrawn: number; fees: number; payments: number }[];
  changes: HanoverChange[];
  defensiveDriving: { perYear: number | null; events: { date: string; reason: string; fileId: string }[] };
  firstDoc: string | null;
  bills: { statementDate: string; fileId: string; payments: number; activity: HanoverActivity[] }[];
}

export const LINE_LABEL: Record<HanoverLine, string> = { auto: 'Auto', home: 'Home', umbrella: 'Umbrella' };
const LINE_ORDER: HanoverLine[] = ['auto', 'home', 'umbrella'];
const PREFIX: Record<string, HanoverLine> = { A1S: 'auto', HVS: 'home', MNS: 'umbrella' };

/** "A1S M123456" → 'auto'. Falls back to a policy number seen on declarations. */
function lineOf(policy: string, known: Map<string, HanoverLine>): HanoverLine | null {
  return known.get(policy) ?? PREFIX[policy.slice(0, 3)] ?? null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

export function summarizeHanover(stmts: HanoverStmtRow[], today: string): HanoverSummary {
  const decs = stmts
    .filter((s): s is HanoverStmtRow & { values: HanoverPolicyValues } => s.values.doc === 'policy')
    .sort((a, b) => a.values.effective.localeCompare(b.values.effective) || a.periodEnd.localeCompare(b.periodEnd));
  const notices = stmts
    .filter((s): s is HanoverStmtRow & { values: HanoverBillValues } => s.values.doc === 'bill')
    .sort((a, b) => a.values.statementDate.localeCompare(b.values.statementDate));
  const known = new Map<string, HanoverLine>(decs.map((d) => [d.values.policyNumber, d.values.line]));
  const onNotices = new Set<HanoverLine>();
  for (const n of notices) for (const p of n.values.policies) {
    const l = lineOf(p, known);
    if (l) onNotices.add(l);
  }
  const latestNotice = notices[notices.length - 1]?.values ?? null;

  // ---- Policies: the newest declarations in effect today (else the newest) ----
  const policies: HanoverPolicy[] = [];
  for (const line of LINE_ORDER) {
    const mine = decs.filter((d) => d.values.line === line);
    if (!mine.length) continue;
    const inEffect = mine.filter((d) => d.values.effective <= today);
    const cur = (inEffect.length ? inEffect : mine)[(inEffect.length ? inEffect : mine).length - 1].values;
    const term = mine.filter((d) => d.values.termStart === cur.termStart);
    policies.push({
      line,
      label: LINE_LABEL[line],
      policyNumber: cur.policyNumber,
      termStart: cur.termStart,
      termEnd: cur.termEnd,
      premium: cur.premium,
      termStartPremium: term[0]?.values.premium ?? cur.premium,
      paidVia: !notices.length ? 'bill' : onNotices.has(line) ? (latestNotice?.autopay ? 'autopay' : 'bill') : 'escrow',
      history: mine.map((d) => ({ effective: d.values.effective, premium: d.values.premium, prevPremium: d.values.prevPremium, reason: d.values.reason, amended: d.values.amended, fileId: d.fileId })),
      current: cur,
    });
  }
  const termEnd = policies.length ? policies.map((p) => p.termEnd).sort().pop()! : null;
  const termStart = policies.length ? policies.map((p) => p.termStart).sort().pop()! : null;
  const annualPremium = round2(policies.reduce((a, p) => a + p.premium, 0));
  const escrowPremium = round2(policies.filter((p) => p.paidVia === 'escrow').reduce((a, p) => a + p.premium, 0));

  // ---- Payments: each scheduled date at the amount on the newest notice issued before it ----
  const dates = new Set<string>();
  for (const n of notices) for (const r of n.values.schedule) dates.add(r.date);
  const payments: HanoverPayment[] = [];
  for (const date of [...dates].sort()) {
    const from = [...notices].reverse().find((n) => n.values.statementDate < date && n.values.schedule.some((r) => r.date === date))
      ?? notices.find((n) => n.values.schedule.some((r) => r.date === date))!;
    // A newer notice that no longer lists this date (but covers dates around it) dropped it.
    const newer = notices.filter((n) => n.values.statementDate > from.values.statementDate && n.values.statementDate < date);
    if (newer.some((n) => n.values.schedule.length && n.values.schedule[0].date < date && !n.values.schedule.some((r) => r.date === date))) continue;
    const row = from.values.schedule.find((r) => r.date === date) as HanoverScheduleRow;
    const byLine: Partial<Record<HanoverLine, number>> = {};
    for (const [p, amt] of Object.entries(row.parts)) {
      const l = lineOf(p, known);
      if (l) byLine[l] = round2((byLine[l] ?? 0) + amt);
    }
    const fee = round2(row.total - Object.values(row.parts).reduce((a, b) => a + b, 0));
    payments.push({ date, total: row.total, byLine, fee, status: date <= today ? 'withdrawn' : 'scheduled', notice: from.values.statementDate });
  }
  const next = payments.find((p) => p.status === 'scheduled') ?? null;
  const last = [...payments].reverse().find((p) => p.status === 'withdrawn') ?? null;
  const inTerm = (p: HanoverPayment) => !!termStart && !!termEnd && p.date >= termStart && p.date < termEnd;
  const paidThisTerm = round2(payments.filter((p) => inTerm(p) && p.status === 'withdrawn').reduce((a, p) => a + p.total, 0));
  const feesThisTerm = round2(payments.filter((p) => inTerm(p) && p.status === 'withdrawn').reduce((a, p) => a + p.fee, 0));
  const remainingThisTerm = round2(payments.filter((p) => inTerm(p) && p.status === 'scheduled').reduce((a, p) => a + p.total, 0));

  const yearMap = new Map<number, { year: number; withdrawn: number; fees: number; payments: number }>();
  for (const p of payments.filter((p) => p.status === 'withdrawn')) {
    const y = Number(p.date.slice(0, 4));
    const r = yearMap.get(y) ?? { year: y, withdrawn: 0, fees: 0, payments: 0 };
    r.withdrawn = round2(r.withdrawn + p.total);
    r.fees = round2(r.fees + p.fee);
    r.payments++;
    yearMap.set(y, r);
  }

  // ---- Terms (renewal trend) ----
  const termMap = new Map<string, HanoverTerm>();
  for (const d of decs) {
    const v = d.values;
    const t = termMap.get(v.termStart) ?? { termStart: v.termStart, termEnd: v.termEnd, start: {}, end: {}, startTotal: 0, endTotal: 0 };
    if (t.start[v.line] === undefined) t.start[v.line] = v.premium;
    if (v.effective <= today || t.end[v.line] === undefined) t.end[v.line] = v.premium;
    if (v.termEnd > t.termEnd) t.termEnd = v.termEnd;
    termMap.set(v.termStart, t);
  }
  const terms = [...termMap.values()].sort((a, b) => a.termStart.localeCompare(b.termStart));
  for (const t of terms) {
    t.startTotal = round2(Object.values(t.start).reduce((a, b) => a + (b ?? 0), 0));
    t.endTotal = round2(Object.values(t.end).reduce((a, b) => a + (b ?? 0), 0));
  }

  // ---- Change log: declarations (annual premium change) + notice activity (billed amounts) ----
  const changes: HanoverChange[] = [];
  for (const d of decs) {
    const v = d.values;
    changes.push({
      date: v.effective,
      line: v.line,
      description: v.reason === 'New Term' ? `New term ${v.termStart.slice(0, 4)}–${v.termEnd.slice(2, 4)}` : v.reason,
      amount: v.prevPremium !== null ? round2(v.premium - v.prevPremium) : null,
      source: 'declarations',
    });
  }
  // Pro-rated amounts billed for each change (from the notices' Recent activity).
  for (const n of notices) for (const a of n.values.activity) {
    if (/installment fee/i.test(a.description)) continue;
    const line = lineOf(a.policy, known);
    const c = changes.find((x) => x.source === 'declarations' && x.line === line && x.date === a.effective);
    if (c) c.billed = a.amount;
  }
  changes.sort((a, b) => b.date.localeCompare(a.date));

  // ---- Defensive driving (NY accident prevention course) ----
  const auto = policies.find((p) => p.line === 'auto');
  const perYear = auto?.current.vehicles?.every((v) => v.defensiveDiscount !== null)
    ? round2(auto.current.vehicles.reduce((a, v) => a + (v.defensiveDiscount ?? 0), 0))
    : null;
  const ddEvents = decs.filter((d) => /defensive|discount/i.test(d.values.reason)).map((d) => ({ date: d.values.effective, reason: d.values.reason, fileId: d.fileId }));

  const allDates = [...decs.map((d) => d.values.effective), ...notices.map((n) => n.values.statementDate)].sort();
  return {
    asOf: allDates[allDates.length - 1] ?? null,
    customer: latestNotice?.customer ?? null,
    last4: latestNotice?.last4 ?? null,
    autopay: latestNotice?.autopay ?? null,
    installmentFee: latestNotice?.installmentFee ?? null,
    termStart,
    termEnd,
    renewsInDays: termEnd ? daysBetween(today, termEnd) : null,
    policies,
    annualPremium,
    billedPremium: round2(annualPremium - escrowPremium),
    escrowPremium,
    vehicles: auto?.current.vehicles ?? [],
    payments,
    next,
    last,
    paidThisTerm,
    feesThisTerm,
    remainingThisTerm,
    terms,
    upcoming: (termStart && terms.find((t) => t.termStart > termStart)) || null,
    years: [...yearMap.values()].sort((a, b) => a.year - b.year),
    changes,
    defensiveDriving: { perYear, events: ddEvents },
    firstDoc: allDates[0] ?? null,
    bills: notices.map((n) => ({ statementDate: n.values.statementDate, fileId: n.fileId, payments: n.values.schedule.length, activity: n.values.activity })),
  };
}
