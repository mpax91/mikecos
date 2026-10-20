import { OASDI_RATE, wageBaseFor } from '../ssa/reference';
import type { CareerEmployer, CareerEvent, EarningKind, Paystub } from './types';

/** Finance → Career, derived on every GET (nothing stored): the employer
 * timeline, earnings by year (paystubs first; W-2s from Finance → Taxes and
 * the Social Security record fill years with no paystubs), pay history with
 * raises and job-change jumps, where each paycheck went, equity, and rule-
 * based checks. Not tax advice. */

export interface W2Row {
  year: number;
  employer: string;
  wages: number;
}
export interface SsaYear {
  year: number;
  ss: number;
  medicare: number;
}

/** Elective deferral (402(g)) limit — one limit across every employer in a
 * year. irs.gov "401(k) limit increases" notices; add a year each November. */
export const DEFERRAL_LIMIT: Record<number, number> = {
  2006: 15000, 2007: 15500, 2008: 15500, 2009: 16500, 2010: 16500, 2011: 16500, 2012: 17000, 2013: 17500, 2014: 17500, 2015: 18000, 2016: 18000,
  2017: 18000, 2018: 18500, 2019: 19000, 2020: 19500, 2021: 19500, 2022: 20500, 2023: 22500, 2024: 23000, 2025: 23500, 2026: 24500,
};
const deferralLimit = (y: number) => DEFERRAL_LIMIT[y] ?? DEFERRAL_LIMIT[Math.max(...Object.keys(DEFERRAL_LIMIT).map(Number))];
/** Employee Social Security rate (the 2011–12 payroll-tax holiday cut it to 4.2%). */
const ssRate = (y: number) => (y === 2011 || y === 2012 ? 0.042 : OASDI_RATE);

const round = (n: number) => Math.round(n * 100) / 100;
const BASE_KINDS: EarningKind[] = ['salary', 'hourly', 'overtime', 'pto', 'holiday', 'retro', 'other'];

export type Bucket = 'base' | 'bonus' | 'stipend' | 'severance' | 'equity' | 'other';
export const BUCKETS: Bucket[] = ['base', 'bonus', 'stipend', 'severance', 'equity', 'other'];

/** Which bucket each earnings line counts toward. Reimbursements and imputed
 * income aren't pay (imputed is taxed but never paid; reimbursements repay
 * money spent) — left out of earnings totals. */
function bucketOf(kind: EarningKind): Bucket | null {
  if (kind === 'reimbursement' || kind === 'imputed') return null;
  if (BASE_KINDS.includes(kind)) return 'base';
  if (kind === 'bonus' || kind === 'commission') return 'bonus';
  if (kind === 'stipend') return 'stipend';
  if (kind === 'severance') return 'severance';
  if (kind === 'equity') return 'equity';
  return 'other';
}

type Buckets = Record<Bucket, number>;
const zero = (): Buckets => ({ base: 0, bonus: 0, stipend: 0, severance: 0, equity: 0, other: 0 });

/** One stub's pay by bucket. With no lines, the whole gross goes by the stub's kind. */
export function stubBuckets(s: Paystub): Buckets {
  const b = zero();
  const lines = s.earnings.filter((e) => e.current !== 0);
  if (!lines.length) {
    b[s.kind === 'regular' ? 'base' : s.kind] += s.gross;
    return b;
  }
  for (const e of lines) {
    const k = bucketOf(e.kind);
    if (k) b[k] += e.current;
  }
  // A stub the file name marks as a bonus/severance/stipend: base-looking lines count as that kind.
  if (s.kind !== 'regular' && s.kind !== 'other' && b.base > 0 && b[s.kind] === 0) {
    b[s.kind] += b.base;
    b.base = 0;
  }
  for (const k of BUCKETS) b[k] = round(b[k]);
  return b;
}

const sumKind = (s: Paystub, list: 'taxes' | 'deductions', pred: (k: string) => boolean) => round(s[list].filter((l) => pred(l.kind)).reduce((t, l) => t + l.current, 0));

function periodsPerYear(dates: string[]): number | null {
  if (dates.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000);
  gaps.sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)];
  if (g <= 8) return 52;
  if (g <= 14.5) return 26;
  if (g <= 17) return 24;
  return 12;
}

export interface SalaryPoint {
  date: string;
  employer: string;
  annual: number;
  /** How it was worked out. */
  basis: 'rate' | 'period' | 'letter';
}
export interface PayChange {
  date: string;
  employer: string;
  from: number;
  to: number;
  pct: number;
  kind: 'raise' | 'cut' | 'job_change';
  gapDays: number | null;
}

export interface EmployerView {
  id: string;
  name: string;
  aliases: string[];
  title: string | null;
  isCurrent: boolean;
  start: string | null;
  end: string | null;
  months: number | null;
  stubs: number;
  firstStub: string | null;
  lastStub: string | null;
  totals: Buckets & { gross: number; net: number; taxes: number; k401: number };
  equityCash: number;
  startSalary: number | null;
  endSalary: number | null;
  frequency: number | null;
  provider: string | null;
  notes: string | null;
  folderNames: string[];
}

export interface YearView {
  year: number;
  /** Where the year's total comes from. */
  source: 'paystubs' | 'w2' | 'ssa' | 'mixed';
  total: number;
  buckets: Buckets;
  equityCash: number;
  byEmployer: { id: string; name: string; gross: number; source: 'paystubs' | 'w2'; partial: boolean }[];
  taxes: { federal: number; socialSecurity: number; medicare: number; stateLocal: number; other: number; total: number } | null;
  deductions: { k401: number; health: number; other: number } | null;
  net: number | null;
  w2: number | null;
  ssa: number | null;
  stubs: number;
}

export interface CareerCheck {
  id: string;
  level: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
  year?: number;
  employer?: string;
}

export interface CareerSummary {
  employers: EmployerView[];
  years: YearView[];
  stubs: Paystub[];
  events: CareerEvent[];
  salary: SalaryPoint[];
  changes: PayChange[];
  checks: CareerCheck[];
  totals: {
    lifetime: number;
    paystubTotal: number;
    equityCash: number;
    bestYear: { year: number; total: number } | null;
    years: number;
    firstYear: number | null;
    currentSalary: number | null;
    startSalary: number | null;
    cagr: number | null;
    severance: number;
    bonus: number;
  };
  current: {
    employer: string | null;
    lastStub: Paystub | null;
    ytd: { gross: number; net: number; taxes: number; k401: number } | null;
    nextPayDate: string | null;
    annualSalary: number | null;
    ssMaxDate: string | null;
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|corp|corporation|co|ltd|the|company|usa|us)\b/g, '').replace(/\s+/g, ' ').trim();

function matchEmployer(name: string, employers: CareerEmployer[]): CareerEmployer | null {
  const n = norm(name);
  if (!n) return null;
  for (const e of employers) {
    for (const a of [e.name, ...e.aliases, ...e.folder_names]) {
      const m = norm(a);
      if (m && (n === m || n.startsWith(`${m} `) || m.startsWith(`${n} `) || n.includes(m) || m.includes(n))) return e;
    }
  }
  return null;
}

const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const monthsBetween = (a: string, b: string) => Math.max(0, Math.round(((Date.parse(b) - Date.parse(a)) / 86400000 / 30.44) * 10) / 10);

export function summarizeCareer(input: {
  employers: CareerEmployer[];
  stubs: Paystub[];
  events: CareerEvent[];
  w2: W2Row[];
  refundable: Map<number, { refundable: number | null; detail: string | null }>;
  ssa: SsaYear[];
  today: string;
}): CareerSummary {
  const { employers, events, w2, ssa, today } = input;
  const stubs = [...input.stubs].sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id));
  const empName = new Map(employers.map((e) => [e.id, e.name]));
  const checks: CareerCheck[] = [];

  // ---- pay history ----
  // Each regular paystub gives a salary: the printed rate (yearly, or hourly × 2,080, or per
  // pay period × paychecks a year), else the salary line × paychecks a year. A per-period
  // figure only counts once two paystubs in a row agree (first/last paychecks are partial,
  // payouts land on the salary line); printed rates and offer / raise letters count at once.
  const salary: SalaryPoint[] = [];
  const freqBy = new Map<string, number | null>();
  for (const e of employers) {
    const regular = stubs.filter((s) => s.employer === e.id && s.kind === 'regular');
    const freq = periodsPerYear(regular.map((s) => s.pay_date));
    freqBy.set(e.id, freq);
    const pts: SalaryPoint[] = [];
    for (const s of regular) {
      let annual: number | null = null;
      let basis: SalaryPoint['basis'] = 'rate';
      const workLine = s.earnings.find((l) => (l.kind === 'salary' || l.kind === 'hourly') && l.current > 0);
      if (s.rate?.per === 'year') annual = s.rate.amount;
      else if (s.rate?.per === 'hour' && s.rate.amount > 0 && workLine) annual = s.rate.amount * 2080;
      else if (s.rate?.per === 'period' && freq) annual = s.rate.amount * freq;
      if (annual == null && freq) {
        const salaryLine = s.earnings.find((l) => l.kind === 'salary' && l.current > 0);
        if (salaryLine) {
          annual = salaryLine.current * freq;
          basis = 'period';
        }
      }
      if (annual && annual > 1000) pts.push({ date: s.pay_date, employer: e.id, annual: Math.round(annual), basis });
    }
    for (const x of e.salaries ?? []) pts.push({ date: x.date, employer: e.id, annual: Math.round(x.annual), basis: 'letter' });
    pts.sort((a, b) => a.date.localeCompare(b.date));
    const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) < 0.004;
    const kept: SalaryPoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = kept.at(-1);
      if (prev && near(prev.annual, p.annual)) continue;
      const confirmed = p.basis !== 'period' || (pts[i + 1] && near(pts[i + 1].annual, p.annual));
      if (!confirmed) continue;
      kept.push(p);
    }
    salary.push(...kept);
  }
  const steady = [...salary].sort((a, b) => a.date.localeCompare(b.date));

  // ---- employers ----
  const w2ByEmp = new Map<string, number[]>();
  for (const w of w2) {
    const m = matchEmployer(w.employer, employers);
    if (m) w2ByEmp.set(m.id, [...(w2ByEmp.get(m.id) ?? []), w.year]);
  }
  const empViews: EmployerView[] = employers.map((e) => {
    const mine = stubs.filter((s) => s.employer === e.id);
    const t = { ...zero(), gross: 0, net: 0, taxes: 0, k401: 0 };
    for (const s of mine) {
      const b = stubBuckets(s);
      for (const k of BUCKETS) t[k] = round(t[k] + b[k]);
      t.gross = round(t.gross + BUCKETS.reduce((x, k) => x + b[k], 0));
      t.net = round(t.net + (s.net ?? 0));
      t.taxes = round(t.taxes + (s.taxes_total ?? s.taxes.reduce((x, l) => x + l.current, 0)));
      t.k401 = round(t.k401 + sumKind(s, 'deductions', (k) => k === '401k' || k === 'roth_401k'));
    }
    const eq = events.filter((x) => x.employer === e.id && !x.via_payroll && x.kind !== 'report' && x.kind !== 'option_grant').reduce((s, x) => s + (x.gross ?? x.net ?? 0), 0);
    const pts = steady.filter((p) => p.employer === e.id);
    const paid = mine.filter((s) => s.gross > 0);
    const firstStub = paid[0]?.pay_date ?? null;
    const lastStub = paid.at(-1)?.pay_date ?? null;
    // Start: the earliest thing that shows Mike working there.
    const w2y = [...(w2ByEmp.get(e.id) ?? [])].sort((a, b) => a - b);
    const candidates = [paid[0]?.period_start ?? firstStub, ...(e.salaries ?? []).map((x) => x.date), ...events.filter((x) => x.employer === e.id && x.kind === 'option_grant').map((x) => x.date)].filter(
      (x): x is string => !!x,
    );
    const startGuess = candidates.sort()[0] ?? (w2y[0] ? `${w2y[0]}-01-01` : null);
    const lastRegular = [...mine].reverse().find((s) => s.kind === 'regular' && s.gross > 0);
    const endGuess = lastRegular?.period_end ?? lastRegular?.pay_date ?? (w2y.length ? `${w2y.at(-1)}-12-31` : null);
    return {
      id: e.id,
      name: e.name,
      aliases: e.aliases,
      title: e.title,
      isCurrent: e.is_current,
      start: e.start_date ?? startGuess,
      end: e.is_current ? null : e.end_date ?? endGuess,
      months: null,
      stubs: paid.length,
      firstStub,
      lastStub,
      totals: t,
      equityCash: round(eq),
      startSalary: pts[0]?.annual ?? null,
      endSalary: pts.at(-1)?.annual ?? null,
      frequency: freqBy.get(e.id) ?? null,
      provider: mine.at(-1)?.provider ?? null,
      notes: e.notes,
      folderNames: e.folder_names,
    };
  });
  empViews.sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'));
  for (let i = 0; i < empViews.length; i++) {
    const v = empViews[i];
    const next = empViews[i + 1];
    // A job with nothing to say when it ended: it ended when the next one began.
    if (!v.isCurrent && next?.start && (!v.end || (v.stubs === 0 && v.end >= next.start))) v.end = addDays(next.start, -1);
    v.months = v.start ? monthsBetween(v.start, v.end ?? today) : null;
  }

  // Raises within a job, and the jump at each job change (last salary → next job's first).
  const changes: PayChange[] = [];
  for (const v of empViews) {
    const pts = steady.filter((p) => p.employer === v.id);
    for (let i = 1; i < pts.length; i++)
      changes.push({
        date: pts[i].date,
        employer: v.id,
        from: pts[i - 1].annual,
        to: pts[i].annual,
        pct: Math.round(((pts[i].annual - pts[i - 1].annual) / pts[i - 1].annual) * 1000) / 10,
        kind: pts[i].annual >= pts[i - 1].annual ? 'raise' : 'cut',
        gapDays: null,
      });
  }
  for (let i = 1; i < empViews.length; i++) {
    const prev = [...empViews.slice(0, i)].reverse().find((v) => v.endSalary);
    const cur = empViews[i];
    const first = steady.find((p) => p.employer === cur.id);
    if (!prev?.endSalary || !first) continue;
    const gap = prev.end && cur.start ? Math.round((Date.parse(cur.start) - Date.parse(prev.end)) / 86400000) - 1 : null;
    changes.push({
      date: cur.start ?? first.date,
      employer: cur.id,
      from: prev.endSalary,
      to: first.annual,
      pct: Math.round(((first.annual - prev.endSalary) / prev.endSalary) * 1000) / 10,
      kind: 'job_change',
      gapDays: gap != null && gap > 0 ? gap : 0,
    });
  }
  changes.sort((a, b) => a.date.localeCompare(b.date));

  // ---- years ----
  const yearSet = new Set<number>([...stubs.map((s) => Number(s.pay_date.slice(0, 4))), ...w2.map((w) => w.year), ...ssa.filter((s) => s.medicare > 0).map((s) => s.year), ...events.map((e) => Number(e.date.slice(0, 4)))]);
  const w2Matched = w2.map((w) => ({ ...w, emp: matchEmployer(w.employer, employers) }));
  const years: YearView[] = [];
  for (const year of [...yearSet].sort((a, b) => a - b)) {
    if (year > Number(today.slice(0, 4))) continue;
    const ys = stubs.filter((s) => s.pay_date.startsWith(String(year)));
    const buckets = zero();
    const byEmp = new Map<string, { id: string; name: string; gross: number; source: 'paystubs' | 'w2'; partial: boolean }>();
    const taxes = { federal: 0, socialSecurity: 0, medicare: 0, stateLocal: 0, other: 0, total: 0 };
    const ded = { k401: 0, health: 0, other: 0 };
    let net = 0;
    for (const s of ys) {
      const b = stubBuckets(s);
      for (const k of BUCKETS) buckets[k] = round(buckets[k] + b[k]);
      const cur = byEmp.get(s.employer) ?? { id: s.employer, name: empName.get(s.employer) ?? s.employer, gross: 0, source: 'paystubs' as const, partial: false };
      cur.gross = round(cur.gross + BUCKETS.reduce((t, k) => t + b[k], 0));
      byEmp.set(s.employer, cur);
      for (const l of s.taxes) {
        const k = l.kind === 'federal' ? 'federal' : l.kind === 'social_security' ? 'socialSecurity' : l.kind === 'medicare' ? 'medicare' : l.kind === 'state' || l.kind === 'local' || l.kind === 'sdi' || l.kind === 'pfl' ? 'stateLocal' : 'other';
        taxes[k] = round(taxes[k] + l.current);
      }
      for (const l of s.deductions) {
        const k = l.kind === '401k' || l.kind === 'roth_401k' ? 'k401' : ['medical', 'dental', 'vision', 'hsa', 'fsa'].includes(l.kind) ? 'health' : 'other';
        ded[k] = round(ded[k] + l.current);
      }
      net = round(net + (s.net ?? 0));
    }
    taxes.total = round(taxes.federal + taxes.socialSecurity + taxes.medicare + taxes.stateLocal + taxes.other);
    // Employers with a W-2 that year but few/no paystubs: use the W-2 (box 1 understates
    // gross by pre-tax deductions — close enough for years with nothing else).
    const yw2 = w2Matched.filter((w) => w.year === year);
    let usedW2 = false;
    for (const w of yw2) {
      const id = w.emp?.id ?? `w2:${norm(w.employer).replace(/ /g, '-') || 'unknown'}`;
      const cur = byEmp.get(id);
      if (!cur) {
        byEmp.set(id, { id, name: w.emp?.name ?? w.employer, gross: w.wages, source: 'w2', partial: false });
        usedW2 = true;
      } else if (cur.source === 'paystubs' && w.wages > cur.gross * 1.08 + 500) {
        // Paystubs cover only part of the year — the W-2 is the fuller number.
        cur.partial = true;
      }
    }
    const fromStubs = round([...byEmp.values()].filter((x) => x.source === 'paystubs').reduce((t, x) => t + x.gross, 0));
    const fromW2 = round([...byEmp.values()].filter((x) => x.source === 'w2').reduce((t, x) => t + x.gross, 0));
    const eqCash = round(events.filter((e) => e.date.startsWith(String(year)) && !e.via_payroll && e.kind !== 'report' && e.kind !== 'option_grant').reduce((t, e) => t + (e.gross ?? e.net ?? 0), 0));
    // Partial paystub years: take the W-2 number for that employer when it's bigger.
    let partialLift = 0;
    for (const x of byEmp.values()) {
      if (x.source !== 'paystubs' || !x.partial) continue;
      const w = yw2.find((w) => w.emp?.id === x.id);
      if (w) partialLift += w.wages - x.gross;
    }
    const ssaRow = ssa.find((s) => s.year === year) ?? null;
    let total = round(fromStubs + fromW2 + partialLift);
    let source: YearView['source'] = ys.length && (usedW2 || partialLift > 0) ? 'mixed' : ys.length ? 'paystubs' : 'w2';
    if (!ys.length && !yw2.length) {
      total = ssaRow?.medicare ?? 0;
      source = 'ssa';
    }
    const w2sum = yw2.length ? round(yw2.reduce((t, w) => t + w.wages, 0)) : null;
    years.push({
      year,
      source,
      total: round(total + eqCash),
      buckets: { ...buckets, base: round(buckets.base + fromW2 + partialLift + (source === 'ssa' ? total : 0)), equity: round(buckets.equity + eqCash) },
      equityCash: eqCash,
      byEmployer: [...byEmp.values()].sort((a, b) => b.gross - a.gross),
      taxes: ys.length ? taxes : null,
      deductions: ys.length ? ded : null,
      net: ys.length ? net : null,
      w2: w2sum,
      ssa: ssaRow?.medicare ?? null,
      stubs: ys.length,
    });
  }

  // ---- checks ----
  for (const y of years) {
    const ys = stubs.filter((s) => s.pay_date.startsWith(String(y.year)));
    const emps = [...new Set(ys.map((s) => s.employer))];
    // Excess Social Security: two+ employers each withholding up to the wage base.
    if (emps.length >= 2 && y.taxes) {
      const cap = round(wageBaseFor(y.year) * ssRate(y.year));
      const excess = round(y.taxes.socialSecurity - cap);
      if (excess > 1) {
        const ref = input.refundable.get(y.year);
        checks.push({
          id: `excess_ss:${y.year}`,
          level: 'warn',
          year: y.year,
          title: `${y.year}: $${Math.round(excess).toLocaleString('en-US')} too much Social Security withheld`,
          detail: `${emps.map((e) => empName.get(e) ?? e).join(' and ')} together withheld $${Math.round(y.taxes.socialSecurity).toLocaleString('en-US')} — the most anyone owes that year is $${Math.round(cap).toLocaleString('en-US')}. The extra comes back as a credit on that year's 1040 (Schedule 3, "excess social security"). ${ref ? `Your ${y.year} return shows refundable credits of ${ref.refundable == null ? 'nothing listed' : `$${Math.round(ref.refundable).toLocaleString('en-US')}`}${ref.detail ? ` (${ref.detail})` : ''} — check it includes this.` : `No ${y.year} return in Taxes to check against.`} Refunds can be claimed up to 3 years after filing.`,
        });
      }
    }
    // 401(k) over the limit across employers.
    if (y.deductions && y.deductions.k401 > 0) {
      const lim = deferralLimit(y.year);
      if (y.deductions.k401 > lim + 1)
        checks.push({
          id: `k401_over:${y.year}`,
          level: 'warn',
          year: y.year,
          title: `${y.year}: 401(k) over the yearly limit`,
          detail: `$${Math.round(y.deductions.k401).toLocaleString('en-US')} deferred across ${emps.length} employer${emps.length === 1 ? '' : 's'} vs the $${lim.toLocaleString('en-US')} limit (the limit counts every employer together, catch-up aside). An excess has to be withdrawn by April 15 of the next year or it's taxed twice.`,
        });
    }
    // Paystub total vs W-2 vs Social Security record.
    for (const emp of emps) {
      const mine = ys.filter((s) => s.employer === emp);
      const last = mine.at(-1);
      const w = w2Matched.filter((x) => x.year === y.year && x.emp?.id === emp);
      if (!last || !w.length) continue;
      const w2w = w.reduce((t, x) => t + x.wages, 0);
      const gross = last.ytd?.gross ?? mine.reduce((t, s) => t + s.gross, 0);
      const pre = mine.reduce((t, s) => t + s.deductions.filter((d) => d.pre_tax && d.kind !== 'roth_401k').reduce((x, d) => x + d.current, 0), 0);
      const expected = gross - pre;
      if (Math.abs(expected - w2w) > Math.max(1000, expected * 0.05) && mine.length >= 6)
        checks.push({
          id: `w2:${y.year}:${emp}`,
          level: 'info',
          year: y.year,
          employer: emp,
          title: `${y.year} ${empName.get(emp) ?? emp}: paystubs and W-2 don't line up`,
          detail: `Paystubs show $${Math.round(gross).toLocaleString('en-US')} gross minus $${Math.round(pre).toLocaleString('en-US')} pre-tax = about $${Math.round(expected).toLocaleString('en-US')} taxable, but the W-2 on your return says $${Math.round(w2w).toLocaleString('en-US')}. Usually missing paystubs in the folder; otherwise worth a look.`,
        });
    }
    if (y.ssa != null && y.w2 != null && y.ssa < y.w2 * 0.97 - 500 && y.ssa < wageBaseFor(y.year) - 500)
      checks.push({
        id: `ssa:${y.year}`,
        level: 'info',
        year: y.year,
        title: `${y.year}: Social Security record lower than your W-2s`,
        detail: `SSA has $${Math.round(y.ssa).toLocaleString('en-US')} in Medicare earnings vs $${Math.round(y.w2).toLocaleString('en-US')} in W-2 wages (W-2 box 1 is usually LOWER than Medicare wages, so a lower SSA figure means something may be missing). See Finance → Social Security.`,
      });
  }
  // Gaps between jobs, and how much of each the severance covered.
  for (const c of changes.filter((c) => c.kind === 'job_change' && (c.gapDays ?? 0) > 45)) {
    const idx = empViews.findIndex((v) => v.id === c.employer);
    const prevEmp = [...empViews.slice(0, idx)].reverse().find((v) => v.endSalary);
    // Only when the old job's paystubs run right up to its end (else the "gap" is just missing files).
    const tail = prevEmp?.end ? stubs.filter((s) => s.employer === prevEmp.id && s.pay_date >= addDays(prevEmp.end!, -90)).length : 0;
    if (!prevEmp || tail < 4) continue;
    const sev = prevEmp.totals.severance;
    checks.push({
      id: `gap:${c.date}`,
      level: 'info',
      title: `${Math.round(c.gapDays! / 7)} weeks between ${prevEmp?.name ?? 'jobs'} and ${empName.get(c.employer) ?? c.employer}`,
      detail: sev ? `Severance of $${Math.round(sev).toLocaleString('en-US')} covered about ${Math.round((sev / c.from) * 52)} weeks of the old salary.` : 'No severance on file for that gap.',
    });
  }
  for (const e of employers) {
    if (stubs.some((s) => s.employer === e.id) || w2ByEmp.has(e.id) || (e.salaries ?? []).length) continue;
    const v = empViews.find((x) => x.id === e.id);
    if (e.is_current && v?.start && v.start > addDays(today, -21)) continue; // just started — first paystub on its way
    checks.push({ id: `nostubs:${e.id}`, level: 'info', employer: e.id, title: `${e.name}: no paystubs read yet`, detail: "Its folder is listed under Employers & Files — files that couldn't be read show the reason." });
  }

  // ---- current job ----
  const curEmp = employers.find((e) => e.is_current) ?? null;
  const curStubs = curEmp ? stubs.filter((s) => s.employer === curEmp.id) : [];
  const lastStub = curStubs.at(-1) ?? null;
  const thisYear = today.slice(0, 4);
  const ytdStubs = curStubs.filter((s) => s.pay_date.startsWith(thisYear));
  let nextPayDate: string | null = null;
  if (lastStub && curEmp) {
    const freq = freqBy.get(curEmp.id) ?? (lastStub.provider === 'Gusto' && lastStub.period_end?.slice(8) === '15' ? 24 : null);
    if (freq === 24) {
      // 15th and last day of the month (next business-day rules aside).
      const d = lastStub.pay_date;
      const day = Number(d.slice(8));
      const y = Number(d.slice(0, 4));
      const m = Number(d.slice(5, 7));
      nextPayDate = day < 15 ? `${d.slice(0, 8)}15` : new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) === d ? `${new Date(Date.UTC(y, m, 15)).toISOString().slice(0, 10)}` : new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    } else if (freq) nextPayDate = addDays(lastStub.pay_date, Math.round(365 / freq));
    if (nextPayDate && nextPayDate < addDays(today, -5))
      checks.push({ id: `late:${nextPayDate}`, level: 'warn', employer: curEmp.id, title: `No ${curEmp.name} paystub since ${lastStub.pay_date}`, detail: `A paycheck was due around ${nextPayDate}. Download it from payroll into the "${curEmp.folder_names[0] ?? curEmp.name}" folder.` });
  }
  const curSalary = curEmp ? steady.filter((p) => p.employer === curEmp.id).at(-1)?.annual ?? null : null;
  // When this year's Social Security withholding will stop (wage base reached).
  let ssMaxDate: string | null = null;
  if (curSalary && lastStub) {
    const base = wageBaseFor(Number(thisYear));
    const ytd = ytdStubs.reduce((t, s) => t + s.gross - s.deductions.filter((d) => ['medical', 'dental', 'vision', 'fsa', 'hsa', 'commuter'].includes(d.kind)).reduce((x, d) => x + d.current, 0), 0);
    const left = base - ytd;
    if (left > 0) {
      const days = (left / curSalary) * 365;
      const d = addDays(lastStub.pay_date, Math.ceil(days));
      if (d.slice(0, 4) === thisYear) ssMaxDate = d;
    }
  }

  const lifetime = round(years.reduce((t, y) => t + y.total, 0));
  const best = years.reduce<{ year: number; total: number } | null>((b, y) => (!b || y.total > b.total ? { year: y.year, total: y.total } : b), null);
  const firstSal = steady[0] ?? null;
  const lastSal = steady.at(-1) ?? null;
  const span = firstSal && lastSal ? (Date.parse(lastSal.date) - Date.parse(firstSal.date)) / (365.25 * 86400000) : 0;
  const nonEmpty = years.filter((y) => y.total > 0);

  return {
    employers: empViews,
    years,
    stubs,
    events,
    salary: steady,
    changes,
    checks,
    totals: {
      lifetime,
      paystubTotal: round(stubs.reduce((t, s) => t + s.gross, 0)),
      equityCash: round(events.filter((e) => !e.via_payroll && e.kind !== 'report' && e.kind !== 'option_grant').reduce((t, e) => t + (e.gross ?? e.net ?? 0), 0)),
      bestYear: best,
      years: nonEmpty.length,
      firstYear: nonEmpty[0]?.year ?? null,
      currentSalary: curSalary ?? lastSal?.annual ?? null,
      startSalary: firstSal?.annual ?? null,
      cagr: firstSal && lastSal && span >= 2 ? Math.round((Math.pow(lastSal.annual / firstSal.annual, 1 / span) - 1) * 1000) / 10 : null,
      severance: round(stubs.reduce((t, s) => t + stubBuckets(s).severance, 0)),
      bonus: round(stubs.reduce((t, s) => t + stubBuckets(s).bonus, 0)),
    },
    current: {
      employer: curEmp?.id ?? null,
      lastStub,
      ytd: ytdStubs.length
        ? {
            gross: round(ytdStubs.reduce((t, s) => t + s.gross, 0)),
            net: round(ytdStubs.reduce((t, s) => t + (s.net ?? 0), 0)),
            taxes: round(ytdStubs.reduce((t, s) => t + (s.taxes_total ?? 0), 0)),
            k401: round(ytdStubs.reduce((t, s) => t + sumKind(s, 'deductions', (k) => k === '401k' || k === 'roth_401k'), 0)),
          }
        : null,
      nextPayDate,
      annualSalary: curSalary,
      ssMaxDate,
    },
  };
}
