import type { SsaStatement } from './types';
import { breakEvenAge, computeBenefit, indexEarnings, type BenefitInput } from './projection';
import { wageBaseFor } from './reference';

/** Everything Finance → Social Security shows, derived on read from the
 * stored statements (+ W-2 wages from Finance → Taxes for the cross-check).
 * Rule-based; nothing here is advice. */

export interface SsaYear {
  year: number;
  ss: number;
  medicare: number;
  wageBase: number;
  atMax: boolean;
  /** Value of that year in the projection (wage-indexed, today's dollars). */
  indexed: number;
  /** In the best 35 for a full-retirement-age claim (keep-maxing plan). */
  counted: boolean;
  /** Statement the figure comes from. */
  source: string;
  /** Earlier statements showed a different number for this year. */
  history: { statement: string; ss: number; medicare: number; latestOnThatStatement: boolean }[];
  /** Spread from a combined range on every statement (no year-by-year figure seen). */
  estimated: boolean;
  w2: number | null;
}

export interface SsaCheck {
  key: string;
  level: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
}

export interface SsaEstimatePoint {
  statement: string;
  at62: number | null;
  atFra: number | null;
  at70: number | null;
  assumed: number | null;
  disability: number | null;
  sameAsPrevious: boolean;
}

/** grid[stopAge][claimAge] = monthly at claim (today's dollars). */
export interface SsaProjection {
  asOfYear: number;
  currentAge: number;
  fraYears: number;
  future: number;
  stopAges: number[];
  claimAges: number[];
  grid: Record<string, Record<string, { monthly: number; fromJanuary: number | null }>>;
  /** Our math vs the latest statement's own numbers, same assumptions. */
  calibration: { age: number; ours: number; ssa: number }[];
  pia: number;
  aime: number;
  zeroYearsInTop35: number;
  /** Adding one more year at the assumed earnings, claim at FRA. */
  nextYearAdds: number;
  breakEven: { from: number; to: number; age: number | null }[];
}

export interface SsaSummary {
  statements: (SsaStatement & { sameAsPrevious: boolean })[];
  latest: (SsaStatement & { sameAsPrevious: boolean }) | null;
  years: SsaYear[];
  estimates: SsaEstimatePoint[];
  projection: SsaProjection | null;
  totals: {
    ssEarnings: number;
    medicareEarnings: number;
    yearsWorked: number;
    yearsAtMax: number;
    maxStreak: number;
    maxStreakFrom: number | null;
    taxesYou: number | null;
    taxesEmployer: number | null;
  };
  checks: SsaCheck[];
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function ageOn(birth: string, iso: string): number {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = iso.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Single years from a statement (ranges kept for spreading). */
function singleYears(s: SsaStatement) {
  return s.earnings.filter((r) => r.from === r.to);
}

export function summarizeSsa(input: SsaStatement[], w2ByYear: Map<number, number>, today: string): SsaSummary {
  const sorted = [...input].sort((a, b) => a.statement_date.localeCompare(b.statement_date));
  const statements = sorted.map((s, i) => {
    const prev = sorted[i - 1];
    const same =
      !!prev &&
      JSON.stringify(prev.retirement) === JSON.stringify(s.retirement) &&
      JSON.stringify(prev.earnings.slice(-3)) === JSON.stringify(s.earnings.slice(-3));
    return { ...s, sameAsPrevious: same };
  });
  const latest = statements.length ? statements[statements.length - 1] : null;

  // ── Earnings record: each year from the newest statement that lists it on its own.
  const byYear = new Map<number, SsaYear>();
  for (const s of statements) {
    const lastYearOnIt = Math.max(...s.earnings.map((r) => r.to));
    for (const r of singleYears(s)) {
      const y = byYear.get(r.from);
      const hist = { statement: s.statement_date, ss: r.ss, medicare: r.medicare, latestOnThatStatement: r.from === lastYearOnIt };
      if (!y) {
        byYear.set(r.from, { year: r.from, ss: r.ss, medicare: r.medicare, wageBase: wageBaseFor(r.from), atMax: false, indexed: 0, counted: false, source: s.statement_date, history: [hist], estimated: false, w2: null });
      } else {
        y.history.push(hist);
        y.ss = r.ss;
        y.medicare = r.medicare;
        y.source = s.statement_date;
      }
    }
  }
  // Ranges only ever seen combined (e.g. a first statement that starts at 2022): spread evenly.
  if (latest) {
    for (const r of latest.earnings.filter((e) => e.from !== e.to)) {
      const known = [];
      for (let y = r.from; y <= r.to; y++) if (byYear.has(y)) known.push(y);
      if (known.length) continue;
      const n = r.to - r.from + 1;
      for (let y = r.from; y <= r.to; y++)
        byYear.set(y, { year: y, ss: Math.round(r.ss / n), medicare: Math.round(r.medicare / n), wageBase: wageBaseFor(y), atMax: false, indexed: 0, counted: false, source: latest.statement_date, history: [], estimated: true, w2: null });
    }
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  for (const y of years) {
    y.atMax = y.ss > 0 && y.ss >= y.wageBase;
    y.w2 = w2ByYear.get(y.year) ?? null;
  }

  // ── Estimates over time.
  const estimates: SsaEstimatePoint[] = statements.map((s) => ({
    statement: s.statement_date,
    at62: s.retirement['62'] ?? null,
    atFra: s.fra_years ? (s.retirement[String(s.fra_years)] ?? null) : null,
    at70: s.retirement['70'] ?? null,
    assumed: s.assumed_earnings,
    disability: s.disability,
    sameAsPrevious: s.sameAsPrevious,
  }));

  // ── Totals.
  const worked = years.filter((y) => y.ss > 0);
  let streak = 0;
  let streakFrom: number | null = null;
  for (let i = years.length - 1; i >= 0 && years[i].atMax; i--) {
    streak++;
    streakFrom = years[i].year;
  }
  const totals = {
    ssEarnings: years.reduce((s, y) => s + y.ss, 0),
    medicareEarnings: years.reduce((s, y) => s + y.medicare, 0),
    yearsWorked: worked.length,
    yearsAtMax: years.filter((y) => y.atMax).length,
    maxStreak: streak,
    maxStreakFrom: streakFrom,
    taxesYou: latest ? (latest.taxes.ss_you ?? 0) + (latest.taxes.medicare_you ?? 0) : null,
    taxesEmployer: latest ? (latest.taxes.ss_employer ?? 0) + (latest.taxes.medicare_employer ?? 0) : null,
  };

  // ── Projection (needs a birth date + FRA from a statement).
  let projection: SsaProjection | null = null;
  const birth = [...statements].reverse().find((s) => s.birth_date)?.birth_date ?? null;
  if (latest && birth && latest.fra_years) {
    const fra = latest.fra_years;
    const asOfYear = Number(today.slice(0, 4));
    const lastActualYear = Math.max(...years.map((y) => y.year));
    const earnings = new Map(years.map((y) => [y.year, y.ss]));
    const future = latest.assumed_earnings ?? wageBaseFor(lastActualYear);
    const currentAge = ageOn(birth, today);
    const base: Omit<BenefitInput, 'stopAge' | 'claimAge'> = { birthDate: birth, fraYears: fra, earnings, lastActualYear, asOfYear, future };
    const claimAges = [62, 63, 64, 65, 66, 67, 68, 69, 70];
    const firstStop = Math.min(Math.max(currentAge, lastActualYear - Number(birth.slice(0, 4)) + 1), 70);
    const stopAges: number[] = [];
    for (let a = firstStop; a <= 70; a++) stopAges.push(a);
    const grid: SsaProjection['grid'] = {};
    for (const stop of stopAges) {
      grid[stop] = {};
      for (const claim of claimAges) {
        const r = computeBenefit({ ...base, stopAge: stop, claimAge: claim });
        grid[stop][claim] = { monthly: r.monthly, fromJanuary: r.monthlyFromJanuary };
      }
    }
    // Calibration: the latest statement's own as-of year + assumption.
    const statementYear = Number(latest.statement_date.slice(0, 4));
    const calEarn = new Map(singleYears(latest).map((r) => [r.from, r.ss]));
    for (const y of years) if (!calEarn.has(y.year) && y.year <= Math.max(...latest.earnings.map((e) => e.to))) calEarn.set(y.year, y.ss);
    const calLast = Math.max(...latest.earnings.map((e) => e.to));
    const calibration = Object.entries(latest.retirement).map(([age, ssa]) => ({
      age: Number(age),
      ssa,
      ours: computeBenefit({ birthDate: birth, fraYears: fra, earnings: calEarn, lastActualYear: calLast, asOfYear: statementYear, future: latest.assumed_earnings ?? wageBaseFor(calLast), stopAge: Number(age), claimAge: Number(age) }).monthly,
    }));
    const atFra = computeBenefit({ ...base, stopAge: fra, claimAge: fra });
    const countedYears = new Set(atFra.counted.map((c) => c.year).filter((y): y is number => y != null));
    for (const y of years) {
      y.counted = countedYears.has(y.year);
      y.indexed = Math.round(indexEarnings(y.year, y.ss, asOfYear));
    }
    const nowStop = stopAges[0];
    const stopNow = computeBenefit({ ...base, stopAge: nowStop, claimAge: fra });
    const stopNext = computeBenefit({ ...base, stopAge: Math.min(nowStop + 1, 70), claimAge: fra });
    const full = (a: number) => ({ age: a, monthly: computeBenefit({ ...base, stopAge: a, claimAge: a }).monthly });
    projection = {
      asOfYear,
      currentAge,
      fraYears: fra,
      future,
      stopAges,
      claimAges,
      grid,
      calibration,
      pia: atFra.pia,
      aime: atFra.aime,
      zeroYearsInTop35: computeBenefit({ ...base, stopAge: nowStop, claimAge: fra }).counted.filter((c) => c.indexed === 0).length,
      nextYearAdds: stopNext.monthly - stopNow.monthly,
      breakEven: [
        { from: 62, to: fra, age: breakEvenAge(full(62), full(fra)) },
        { from: fra, to: 70, age: breakEvenAge(full(fra), full(70)) },
        { from: 62, to: 70, age: breakEvenAge(full(62), full(70)) },
      ],
    };
  }

  // ── Things to check.
  const checks: SsaCheck[] = [];
  if (latest) {
    const ageDays = (Date.parse(today) - Date.parse(latest.statement_date)) / 864e5;
    if (ageDays > 400)
      checks.push({ key: 'stale', level: 'warn', title: 'Download this year\'s statement', detail: `The newest one is from ${longDate(latest.statement_date)}. SSA updates it once your last year's W-2s post (usually by spring) — download it from my Social Security and save it to the Drive folder.` });
    const corrected = years.flatMap((y) => {
      const out: string[] = [];
      for (let i = 1; i < y.history.length; i++) {
        const a = y.history[i - 1];
        const b = y.history[i];
        if (a.ss === b.ss && a.medicare === b.medicare) continue;
        if (a.latestOnThatStatement) continue; // the newest year often fills in later — normal
        out.push(`${y.year}: ${fmt(a.ss)} on the ${longDate(a.statement)} statement → ${fmt(b.ss)} on ${longDate(b.statement)}${a.medicare !== b.medicare && a.ss === b.ss ? ` (Medicare ${fmt(a.medicare)} → ${fmt(b.medicare)})` : ''}`);
      }
      return out;
    });
    if (corrected.length)
      checks.push({ key: 'corrected', level: 'info', title: `SSA changed ${corrected.length === 1 ? 'a past year' : `${corrected.length} past years`} on your record`, detail: `${corrected.join('; ')}. Worth knowing it happens — compare against your W-2s if a year ever looks short.` });
    const late = years.flatMap((y) => {
      for (let i = 1; i < y.history.length; i++) {
        const a = y.history[i - 1];
        const b = y.history[i];
        if (a.latestOnThatStatement && (a.ss !== b.ss || a.medicare !== b.medicare)) return [a.ss !== b.ss ? `${y.year} (${fmt(a.ss)} → ${fmt(b.ss)})` : `${y.year} (Medicare ${fmt(a.medicare)} → ${fmt(b.medicare)})`];
      }
      return [];
    });
    if (late.length)
      checks.push({ key: 'late_posting', level: 'info', title: 'Some years were still filling in when the statement came out', detail: `${late.join(', ')} — the newest year on a statement can be incomplete (a late or corrected W-2). Each was fixed on the next statement.` });

    // W-2 cross-check (Finance → Taxes): Medicare earnings should be at least W-2 box 1 wages.
    const short = years.filter((y) => y.w2 != null && y.w2 > 0 && y.medicare < y.w2 - Math.max(500, y.w2 * 0.02));
    if (short.length)
      checks.push({ key: 'w2_short', level: 'warn', title: `SSA shows less than your W-2 wages for ${short.map((y) => y.year).join(', ')}`, detail: `${short.map((y) => `${y.year}: SSA ${fmt(y.medicare)} Medicare earnings vs ${fmt(y.w2!)} W-2 wages on your return`).join('; ')}. A missing W-2 lowers your benefit — SSA fixes it with the W-2 (1-800-772-1213). You have about 3 years, 3 months and 15 days after a year ends to get it corrected easily.` });
    const compared = years.filter((y) => y.w2 != null && y.w2 > 0).length;
    if (compared && !short.length) checks.push({ key: 'w2_ok', level: 'good', title: `Your record matches your tax returns (${compared} ${compared === 1 ? 'year' : 'years'} checked)`, detail: 'Every year with W-2 wages on a return in Finance → Taxes shows at least that much in Medicare earnings on the SSA record (401(k) deferrals make the SSA figure higher — that\'s normal).' });

    if (totals.maxStreak >= 2)
      checks.push({ key: 'maxed', level: 'good', title: `At the Social Security max every year since ${totals.maxStreakFrom} (${totals.maxStreak} years)`, detail: 'Earnings above the yearly wage max aren\'t taxed for Social Security and don\'t raise your benefit. More income now mostly builds your benefit by replacing your weaker early years in the best 35.' });
    if (projection) {
      if (projection.zeroYearsInTop35 > 0)
        checks.push({ key: 'top35', level: 'info', title: `${projection.zeroYearsInTop35} of your best 35 years are still $0`, detail: `Benefits use your best 35 years. If you stopped working today, ${projection.zeroYearsInTop35} empty years would count. Each more year at about ${fmt(projection.future)} adds roughly ${fmt(projection.nextYearAdds)}/month at ${projection.fraYears} (today's dollars).` });
      const off = projection.calibration.filter((c) => Math.abs(c.ours - c.ssa) > 3);
      if (off.length)
        checks.push({ key: 'calibration', level: 'info', title: 'MikeOS\'s math differs a little from SSA\'s', detail: off.map((c) => `age ${c.age}: SSA ${fmt(c.ssa)} vs ${fmt(c.ours)}`).join('; ') + '. The what-ifs below use MikeOS\'s math.' });
    }
    if (latest.trust_fund) {
      const fraAmt = latest.fra_years ? latest.retirement[String(latest.fra_years)] : null;
      checks.push({ key: 'trust_fund', level: 'info', title: `Plan for a possible cut around ${latest.trust_fund.year}`, detail: `SSA says that after ${latest.trust_fund.year}, payroll taxes would cover about ${latest.trust_fund.pct}% of scheduled benefits unless Congress acts.${fraAmt ? ` At ${latest.trust_fund.pct}%, your ${fmt(fraAmt)} at ${latest.fra_years} would be about ${fmt((fraAmt * latest.trust_fund.pct) / 100)}.` : ''}` });
    }
    if (latest.survivors.child)
      checks.push({ key: 'survivors', level: 'info', title: 'Survivor benefits are a kind of life insurance', detail: `If you died this year, a minor child could get about ${fmt(latest.survivors.child)}/month and a spouse caring for a child under 16 about ${fmt(latest.survivors.spouse_caring ?? latest.survivors.child)}, up to ${fmt(latest.survivors.family_max ?? 0)}/month for the family. Worth counting when you size life insurance.` });
    const prevReal = [...statements].reverse().find((s) => s.statement_date < latest.statement_date && !s.sameAsPrevious && s.statement_date.slice(0, 4) !== latest.statement_date.slice(0, 4));
    if (prevReal && latest.fra_years) {
      const a = prevReal.retirement[String(latest.fra_years)];
      const b = latest.retirement[String(latest.fra_years)];
      if (a && b && b < a) checks.push({ key: 'estimate_down', level: 'warn', title: `Your estimate went down (${fmt(a)} → ${fmt(b)})`, detail: 'A drop usually means a low or missing year on the record — check the newest year against your W-2s.' });
    }
  }

  return { statements, latest, years, estimates, projection, totals, checks };
}
