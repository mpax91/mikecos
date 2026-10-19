import { awiFor, bendPointsFor, wageBaseFor } from './reference';

/** The retirement-benefit math, done the way SSA does it for the Statement
 * (checked 2026-10-19: reproduces every age on Mike's 2026 statement to the
 * dollar). Everything is in TODAY'S dollars, like the Statement:
 *  - earnings before (as-of year − 2) are wage-indexed to that year's AWI;
 *  - future years are assumed at `future` (the Statement's "continue to earn
 *    $X", = last year's wage max for Mike) until you stop working;
 *  - AIME = best 35 years ÷ 420 (floored), PIA = 90 / 32 / 15% across the
 *    as-of year's bend points (floored to the dime);
 *  - claiming early: −5/9% a month for the first 36 months before full
 *    retirement age, −5/12% beyond; the first month at 62 is the month after
 *    the 62nd birthday (unless born on the 1st/2nd);
 *  - claiming late: +2/3% a month (8%/yr), but credits earned in the year you
 *    claim are only added the next January (at 70 all are counted) — that's
 *    why the Statement's 68 and 69 look low.
 * Earnings count through the year before the year you claim (SSA's
 * convention for the Statement), or the last year you work, if earlier. */

export interface BenefitInput {
  birthDate: string; // YYYY-MM-DD
  fraYears: number;
  /** Actual taxed Social Security earnings by year. */
  earnings: Map<number, number>;
  /** Last year with actual earnings on record. */
  lastActualYear: number;
  /** Year the math is done "as of" (bend points of this year, AWI of this year − 2). */
  asOfYear: number;
  /** Assumed yearly earnings from lastActualYear + 1 on (today's dollars). */
  future: number;
  /** Age you stop working (no earnings from the year you turn it). */
  stopAge: number;
  /** Age you start benefits (62–70). */
  claimAge: number;
}

export interface BenefitResult {
  aime: number;
  pia: number;
  /** Monthly benefit when it starts. */
  monthly: number;
  /** After the January bump (delayed credits from the claim year), if any. */
  monthlyFromJanuary: number | null;
  monthsFromFra: number;
  factor: number;
  /** Years counted in the best 35, with their indexed value. */
  counted: { year: number | null; indexed: number }[];
}

const birthParts = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
};

export function claimFactor(birthDate: string, fraYears: number, claimAge: number): { months: number; initial: number; full: number } {
  const { y, m, d } = birthParts(birthDate);
  if (claimAge < fraYears) {
    let months = (fraYears - claimAge) * 12;
    // At 62 the first month you're 62 all month is the month after your birthday.
    if (claimAge === 62 && d > 2) months -= 1;
    const red = Math.min(months, 36) * (5 / 900) + Math.max(0, months - 36) * (5 / 1200);
    return { months: -months, initial: 1 - red, full: 1 - red };
  }
  const totalMonths = Math.min(70 - fraYears, claimAge - fraYears) * 12;
  if (totalMonths === 0) return { months: 0, initial: 1, full: 1 };
  const fraYear = y + fraYears;
  const claimYear = y + claimAge;
  // Credits through December of the year before the claim year (all of them at 70).
  const creditedNow = claimAge >= 70 ? totalMonths : Math.max(0, Math.min(totalMonths, (claimYear - 1 - fraYear) * 12 + (12 - m + 1)));
  return { months: totalMonths, initial: 1 + creditedNow * (2 / 300), full: 1 + totalMonths * (2 / 300) };
}

/** One year's earnings in today's dollars (wage-indexed to as-of year − 2). */
export function indexEarnings(year: number, amount: number, asOfYear: number): number {
  const idxYear = asOfYear - 2;
  return year < idxYear ? (amount * awiFor(idxYear)) / awiFor(year) : amount;
}

export function computeBenefit(inp: BenefitInput): BenefitResult {
  const { y: birthYear } = birthParts(inp.birthDate);
  const lastYear = Math.min(birthYear + inp.claimAge - 1, birthYear + inp.stopAge - 1);
  const years = new Set<number>([...inp.earnings.keys()].filter((yr) => yr <= lastYear));
  for (let yr = inp.lastActualYear + 1; yr <= lastYear; yr++) years.add(yr);
  const futureCap = wageBaseFor(inp.lastActualYear);
  const indexed = [...years].map((yr) => {
    const e = yr <= inp.lastActualYear ? (inp.earnings.get(yr) ?? 0) : Math.min(inp.future, futureCap);
    return { year: yr as number | null, indexed: indexEarnings(yr, e, inp.asOfYear) };
  });
  indexed.sort((a, b) => b.indexed - a.indexed);
  const counted = indexed.slice(0, 35);
  while (counted.length < 35) counted.push({ year: null, indexed: 0 });
  const aime = Math.floor(counted.reduce((s, c) => s + c.indexed, 0) / 420);
  const [b1, b2] = bendPointsFor(inp.asOfYear);
  const raw = 0.9 * Math.min(aime, b1) + 0.32 * Math.max(0, Math.min(aime, b2) - b1) + 0.15 * Math.max(0, aime - b2);
  const pia = Math.floor(raw * 10 + 1e-9) / 10;
  const f = claimFactor(inp.birthDate, inp.fraYears, inp.claimAge);
  const monthly = Math.floor(pia * f.initial + 1e-9);
  const fullAmt = Math.floor(pia * f.full + 1e-9);
  return { aime, pia, monthly, monthlyFromJanuary: fullAmt !== monthly ? fullAmt : null, monthsFromFra: f.months, factor: f.initial, counted };
}

/** Age you'd have to live past for a later start to pay more in total than an earlier one (today's dollars, no interest). */
export function breakEvenAge(early: { age: number; monthly: number }, late: { age: number; monthly: number }): number | null {
  if (late.monthly <= early.monthly) return null;
  const gapMonths = (late.age - early.age) * 12;
  // early * (t) = late * (t - gap)  →  t = late*gap / (late - early), t months after the early start
  const t = (late.monthly * gapMonths) / (late.monthly - early.monthly);
  return Math.round((early.age + t / 12) * 10) / 10;
}
