import type { TaxReturn } from './types';
import { CPI_BASE_YEAR, SALT_CAP, SALT_PHASEOUT_MAGI, STANDARD_DEDUCTION, marginalFor, realDollars, type MarginalInfo } from './reference';

/** Per-year figures the Taxes dashboard charts (all derived on read). */
export interface TaxYearSummary {
  year: number;
  status: TaxReturn['filing_status'];
  /** false when only the e-file totals are known (no income lines). */
  complete: boolean;
  agi: number | null;
  agiReal: number | null;
  taxableIncome: number | null;
  wages: number | null;
  wagesByWho: Record<string, number>;
  investmentIncome: number | null;
  otherIncome: number | null;
  federalTax: number | null;
  stateTax: number | null;
  nyTax: number | null;
  ctTax: number | null;
  totalTax: number | null;
  effFederal: number | null;
  effTotal: number | null;
  marginal: MarginalInfo | null;
  deductionType: 'standard' | 'itemized' | null;
  deduction: number | null;
  standardDeduction: number | null;
  saltPaid: number | null;
  saltLost: number | null;
  otherTaxes: number | null;
  /** + refund / − owed (penalty included). */
  federalBalance: number | null;
  stateBalance: number | null;
  penalty: number;
  /** Share of the federal tax covered by withholding + estimates. */
  withholdingCoverage: number | null;
  dependents: number;
  amended: boolean;
  preparedBy: string | null;
  doubtCount: number;
}

export type TaxInsightTone = 'warn' | 'info' | 'good';
export interface TaxInsight {
  key: string;
  tone: TaxInsightTone;
  title: string;
  detail: string;
  years: number[];
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const $ = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function stateBalance(s: TaxReturn['ny']): number | null {
  if (!s) return null;
  // An overpayment applied to next year's estimates is still money back.
  return n(s.refund) - n(s.amount_owed);
}

export function summarizeYear(r: TaxReturn): TaxYearSummary {
  const f = r.federal;
  const complete = has(f.total_income);
  const ny = r.ny?.total_tax ?? null;
  const ct = r.ct?.total_tax ?? null;
  // A state return whose total isn't known (e-file totals only) makes the
  // state figure unknown rather than understated.
  const stateUnknown = (r.ny && !has(ny)) || (r.ct && !has(ct));
  const stateTax = stateUnknown ? null : has(ny) || has(ct) ? n(ny) + n(ct) : null;
  const totalTax = has(f.total_tax) && !stateUnknown ? f.total_tax + n(stateTax) : null;
  const agi = has(f.agi) ? f.agi : null;
  const wagesByWho: Record<string, number> = {};
  for (const p of r.people ?? []) wagesByWho[p.who] = (wagesByWho[p.who] ?? 0) + n(p.wages);
  const invest = complete ? n(f.taxable_interest) + n(f.ordinary_dividends) + n(f.capital_gain) : null;
  const other = complete ? n(f.total_income) - n(f.wages) - n(invest) : null;
  const it = r.itemized;
  const saltPaid = it && has(it.salt_paid) ? it.salt_paid : null;
  const saltLost = it && has(it.salt_paid) && has(it.salt_deducted) ? Math.max(0, it.salt_paid - it.salt_deducted) : null;
  const paid = n(f.withholding) + n(f.estimated_payments);
  return {
    year: r.year,
    status: r.filing_status,
    complete,
    agi,
    agiReal: agi !== null ? realDollars(agi, r.year) : null,
    taxableIncome: has(f.taxable_income) ? f.taxable_income : null,
    wages: has(f.wages) ? f.wages : null,
    wagesByWho,
    investmentIncome: invest,
    otherIncome: other,
    federalTax: has(f.total_tax) ? f.total_tax : null,
    stateTax,
    nyTax: ny,
    ctTax: ct,
    totalTax,
    effFederal: agi && has(f.total_tax) ? f.total_tax / agi : null,
    effTotal: agi && totalTax !== null ? totalTax / agi : null,
    marginal: marginalFor(r.filing_status, r.year, has(f.taxable_income) ? f.taxable_income : null),
    deductionType: f.deduction_type ?? null,
    deduction: has(f.deduction) ? f.deduction : null,
    standardDeduction: STANDARD_DEDUCTION[`${r.filing_status}:${r.year}`] ?? null,
    saltPaid,
    saltLost,
    otherTaxes: has(f.other_taxes) ? f.other_taxes : null,
    federalBalance: has(f.refund) || has(f.amount_owed) ? n(f.refund) - n(f.amount_owed) : null,
    stateBalance: r.ny || r.ct ? n(stateBalance(r.ny)) + n(stateBalance(r.ct)) : null,
    penalty: n(f.penalty),
    withholdingCoverage: has(f.total_tax) && f.total_tax > 0 ? paid / f.total_tax : null,
    dependents: n(r.dependents),
    amended: !!r.amended,
    preparedBy: r.prepared_by ?? null,
    doubtCount: (r.doubts ?? []).length,
  };
}

/** Rule-based "Things to Check" — no AI. Each rule reads only the stored
 * years; thresholds are in the rule. Ordered warn → info → good. */
export function taxInsights(rows: TaxReturn[], years: TaxYearSummary[]): TaxInsight[] {
  const out: TaxInsight[] = [];
  if (!years.length) return out;
  const byYear = new Map(years.map((y) => [y.year, y]));
  const latest = years[years.length - 1];
  const latestFull = [...years].reverse().find((y) => y.complete) ?? latest;

  // 1. Data gaps — a year with only e-file totals.
  const partial = years.filter((y) => !y.complete);
  if (partial.length) {
    out.push({
      key: 'partial',
      tone: 'warn',
      title: `${partial.map((y) => y.year).join(', ')}: only the totals are in`,
      detail:
        'AGI, total tax and the refund came from the signed e-file form; the income and deduction lines are missing. Open the year and fill them in from the full return (or drop a smaller copy into the Drive folder and ask Claude to read it).',
      years: partial.map((y) => y.year),
    });
  }

  // 2. Withholding — owed ≥ $5K or a penalty in the last 6 years.
  const recent = years.filter((y) => y.year > latest.year - 6);
  const shortYears = recent.filter((y) => (y.federalBalance ?? 0) <= -5000 || y.penalty > 0);
  if (shortYears.length) {
    const owed = shortYears.reduce((s, y) => s + Math.max(0, -(y.federalBalance ?? 0)), 0);
    const pen = years.reduce((s, y) => s + y.penalty, 0);
    const penYears = years.filter((y) => y.penalty > 0).map((y) => y.year);
    const lastTwoOk = years.slice(-2).every((y) => (y.federalBalance ?? 0) > -1000 && y.penalty === 0);
    out.push({
      key: 'withholding',
      tone: lastTwoOk ? 'info' : 'warn',
      title: `Under-withheld in ${shortYears.length} of the last ${recent.length} years`,
      detail:
        `Paid ${$(owed)} at filing in ${shortYears.map((y) => y.year).join(', ')}` +
        (pen > 0 ? `, plus ${$(pen)} in underpayment penalties over the years (${penYears.join(', ')})` : '') +
        '. Two incomes and mid-year job changes are the usual cause — each employer withholds as if its job were the only one. ' +
        (lastTwoOk
          ? `${years
              .slice(-2)
              .map((y) => `${y.year} ${y.federalBalance !== null && y.federalBalance >= 0 ? `refund ${$(y.federalBalance)}` : `owed ${$(-(y.federalBalance ?? 0))}`}`)
              .join(', ')} — withholding has been close lately; re-check the W-4s after any job change.`
          : 'The W-4 “multiple jobs” box (Step 2) or quarterly estimates fix it; ask the preparer which.'),
      years: shortYears.map((y) => y.year),
    });
  }

  // 3. Big refunds — money lent to the government interest-free.
  // Refundable credits (excess Social Security from two employers, child
  // credits) aren't over-withholding, so they're taken out first.
  const refundable = (yr: number) => n(rows.find((r) => r.year === yr)?.federal.refundable_credits);
  const overWithheld = (y: TaxYearSummary) => (y.federalBalance ?? 0) - refundable(y.year);
  const bigRefunds = recent.filter((y) => overWithheld(y) >= 5000);
  if (bigRefunds.length) {
    out.push({
      key: 'refunds',
      tone: 'info',
      title: `Large refunds in ${bigRefunds.map((y) => y.year).join(', ')}`,
      detail: `About ${$(Math.max(...bigRefunds.map(overWithheld)))} more was withheld than the tax came to — money lent to the IRS interest-free that could have sat in savings.`,
      years: bigRefunds.map((y) => y.year),
    });
  }

  // 4. Effective rate now vs the previous five complete years.
  const prior = years.filter((y) => y.year < latestFull.year && y.year >= latestFull.year - 5 && y.effFederal !== null);
  if (latestFull.effFederal !== null && prior.length >= 3) {
    const avg = prior.reduce((s, y) => s + (y.effFederal ?? 0), 0) / prior.length;
    const diff = latestFull.effFederal - avg;
    if (Math.abs(diff) >= 0.01) {
      out.push({
        key: 'eff_rate',
        tone: 'info',
        title: `${latestFull.year} federal rate ${pct(latestFull.effFederal)} — ${diff < 0 ? 'down' : 'up'} from ${pct(avg)}`,
        detail:
          `Federal income tax as a share of AGI, against the ${prior[0].year}–${prior[prior.length - 1].year} average. ` +
          (latestFull.effTotal !== null ? `With New York${latestFull.ctTax ? ' and Connecticut' : ''} it was ${pct(latestFull.effTotal)}. ` : '') +
          'Social Security and Medicare payroll tax aren’t on the return, so they aren’t counted.',
        years: [latestFull.year],
      });
    }
  }

  // 5. Real income — peak year vs now, in today's dollars.
  const real = years.filter((y) => y.agiReal !== null);
  if (real.length >= 5) {
    const peak = real.reduce((a, b) => ((b.agiReal ?? 0) > (a.agiReal ?? 0) ? b : a));
    const last = real[real.length - 1];
    if (peak.year !== last.year && last.agiReal !== null && peak.agiReal !== null) {
      const drop = 1 - last.agiReal / peak.agiReal;
      if (drop >= 0.05) {
        out.push({
          key: 'real_peak',
          tone: 'info',
          title: `AGI peaked in ${peak.year} — ${last.year} is ${Math.round(drop * 100)}% below it after inflation`,
          detail: `${peak.year}: ${$(peak.agi ?? 0)} (${$(peak.agiReal)} in ${CPI_BASE_YEAR} dollars). ${last.year}: ${$(last.agi ?? 0)}. Prices rose ${Math.round(((realDollars(100, peak.year) ?? 100) / 100 - 1) * 100)}% in between.`,
          years: [peak.year, last.year],
        });
      }
    }
  }

  // 6. SALT cap — deductions lost, and the 2025 change.
  const lostYears = years.filter((y) => (y.saltLost ?? 0) > 0);
  if (lostYears.length) {
    const lost = lostYears.reduce((s, y) => s + (y.saltLost ?? 0), 0);
    const worst = lostYears.reduce((a, b) => ((b.saltLost ?? 0) > (a.saltLost ?? 0) ? b : a));
    const y25 = byYear.get(2025);
    const capNow = SALT_CAP[latest.year + 1] ?? SALT_CAP[latest.year];
    const phase = SALT_PHASEOUT_MAGI[latest.year + 1];
    out.push({
      key: 'salt',
      tone: 'info',
      title: `The SALT cap disallowed ${$(lost)} of state & property tax`,
      detail:
        `Across ${lostYears.map((y) => y.year).join(', ')} (most in ${worst.year}: ${$(worst.saltLost ?? 0)}). ` +
        (y25 && y25.deductionType === 'itemized' && y25.standardDeduction
          ? `With the cap raised to $40,000 for 2025 you itemized ${$(y25.deduction ?? 0)} against a ${$(y25.standardDeduction)} standard deduction. `
          : '') +
        (capNow && phase ? `For ${latest.year + 1} the cap is ${$(capNow)}, shrinking once income passes ${$(phase)}.` : ''),
      years: lostYears.map((y) => y.year),
    });
  }

  // 7. Bracket room on the latest complete year.
  if (latestFull.marginal) {
    const m = latestFull.marginal;
    out.push({
      key: 'bracket',
      tone: 'info',
      title: `${latestFull.year}: top dollar taxed at ${m.rate}% federal`,
      detail:
        (m.roomToNext !== null && m.nextRate !== null ? `Taxable income ${$(latestFull.taxableIncome ?? 0)} — ${$(m.roomToNext)} below the ${m.nextRate}% bracket. ` : '') +
        `Each extra $1,000 of pre-tax 401(k) or HSA money saves about $${Math.round(m.rate * 10)} federal (plus New York). Capital gains and qualified dividends are taxed on their own scale.`,
      years: [latestFull.year],
    });
  }

  // 8. Surtaxes over $250K AGI (joint).
  const surtax = years.filter((y) => (y.otherTaxes ?? 0) > 0 && (y.agi ?? 0) > 250000);
  if (surtax.length >= 2) {
    const total = surtax.reduce((s, y) => s + (y.otherTaxes ?? 0), 0);
    out.push({
      key: 'surtax',
      tone: 'info',
      title: `${$(total)} in surtaxes since ${surtax[0].year}`,
      detail:
        'Above $250,000 of joint income, wages over the line pay an extra 0.9% Medicare tax and investment income an extra 3.8% (Net Investment Income Tax). They show up as “other taxes” on the 1040.',
      years: surtax.map((y) => y.year),
    });
  }

  // 9. Amended returns — usually a form that arrived late or was missed.
  const amended = years.filter((y) => y.amended);
  if (amended.length) {
    const ly = amended[amended.length - 1];
    out.push({
      key: 'amended',
      tone: amended.some((y) => y.year >= latest.year - 3) ? 'warn' : 'info',
      title: `Amended ${amended.length === 1 ? 'once' : `${amended.length} times`} (${amended.map((y) => y.year).join(', ')})`,
      detail:
        `${ly.year}'s amendment ${rows.find((r) => r.year === ly.year)?.notes?.find((t) => /W-2|1099|omit|left off/i.test(t)) ? 'added a form that was left off the original' : 'changed the original return'}. ` +
        'Before filing, check every W-2 (each employer that year) and 1099 against the list from last year — the Tax Packet note collects them.',
      years: amended.map((y) => y.year),
    });
  }

  // 10. NY credited Connecticut's tax — no double tax on Nell's CT wages.
  const ct = years.filter((y) => (y.ctTax ?? 0) > 0);
  if (ct.length) {
    const total = ct.reduce((s, y) => s + (y.ctTax ?? 0), 0);
    out.push({
      key: 'ct_credit',
      tone: 'good',
      title: `Connecticut tax was credited back by New York`,
      detail: `${$(total)} paid to Connecticut on CT wages (${ct[0].year}–${ct[ct.length - 1].year}); New York's resident credit took the same amount off the NY bill each year, so that income wasn't taxed twice.`,
      years: ct.map((y) => y.year),
    });
  }

  const order: Record<TaxInsightTone, number> = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
