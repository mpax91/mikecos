/** Finance → Social Security (Mike, 2026-10-19; migration 0140).
 * One "Your Social Security Statement" (SSA-7005) as stored in
 * ssa_statements.data_json. Whole dollars, monthly benefit amounts; null =
 * not printed on that statement / not readable. The repo is PUBLIC — no
 * statement data ever lives in code, migrations or fixtures; the SSN (even
 * the last 4) is never stored. */

export type SsaLayout =
  /** 2009–2010 mailed paper statements (scans; read by Claude → JSON). */
  | 'paper'
  /** 2016–2021 online statement: "your payment would be about … a month" lines. */
  | 'classic'
  /** Sep 2021 one-off: chart 62–70, "Employer(s) paid:". */
  | 'chart2021'
  /** 2022 → today: "Personalized Monthly Retirement Benefit Estimates" chart 62–70. */
  | 'chart';

export interface SsaEarningsRow {
  /** First and last year (same for a single year; ranges like 1991–2000 on newer statements). */
  from: number;
  to: number;
  ss: number;
  medicare: number;
}

export interface SsaStatement {
  /** Statement date YYYY-MM-DD (also the row id). */
  id: string;
  statement_date: string;
  layout: SsaLayout;
  file_id: string | null;
  file_name: string | null;
  /** Date of birth as printed (YYYY-MM-DD). Needed for ages in the projection. */
  birth_date: string | null;
  /** Full retirement age in years (67 for anyone born 1960+). */
  fra_years: number | null;
  /** Monthly estimate by claiming age ("62".."70"); older statements print only 62 / FRA / 70. */
  retirement: Record<string, number>;
  /** 2009–2010 paper statements: the age-62 figure assumed you STOP working now. */
  age62_stop_now: boolean;
  /** "assume you continue to earn $X per year" / "estimated taxable earnings per year after YYYY". */
  assumed_earnings: number | null;
  disability: number | null;
  survivors: {
    child: number | null;
    spouse_caring: number | null;
    spouse_fra: number | null;
    family_max: number | null;
  };
  death_benefit: number | null;
  earnings: SsaEarningsRow[];
  taxes: {
    ss_you: number | null;
    ss_employer: number | null;
    medicare_you: number | null;
    medicare_employer: number | null;
  };
  /** Trust fund outlook as printed: depletion year + cents per $1 payable (e.g. 2034, 81). */
  trust_fund: { year: number; pct: number } | null;
  notes: string | null;
}
