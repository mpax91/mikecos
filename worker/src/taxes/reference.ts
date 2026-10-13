/** Reference tables for Finance → Taxes. Public facts only (no personal data).
 *
 * CPI-U annual averages (1982–84 = 100, BLS). 2025 = 2024 × (138.289 /
 * 134.655), from the BLS 2013-based series (checked 2026-10-12). Add a year
 * each January. */
export const CPI_U: Record<number, number> = {
  2000: 172.2,
  2001: 177.1,
  2002: 179.9,
  2003: 184.0,
  2004: 188.9,
  2005: 195.3,
  2006: 201.6,
  2007: 207.342,
  2008: 215.303,
  2009: 214.537,
  2010: 218.056,
  2011: 224.939,
  2012: 229.594,
  2013: 232.957,
  2014: 236.736,
  2015: 237.017,
  2016: 240.007,
  2017: 245.12,
  2018: 251.107,
  2019: 255.657,
  2020: 258.811,
  2021: 270.97,
  2022: 292.655,
  2023: 304.702,
  2024: 313.689,
  2025: 322.156,
};

/** Latest year with a CPI value — the "today's dollars" base. */
export const CPI_BASE_YEAR = Math.max(...Object.keys(CPI_U).map(Number));

/** Value of `amount` (in `year` dollars) in CPI_BASE_YEAR dollars; null when
 * the year has no CPI. */
export function realDollars(amount: number, year: number): number | null {
  const from = CPI_U[year];
  if (!from) return null;
  return Math.round((amount * CPI_U[CPI_BASE_YEAR]) / from);
}

type Bracket = [upTo: number, rate: number];
const R_PRE = [10, 15, 25, 28, 33, 35, 39.6];
const R_TCJA = [10, 12, 22, 24, 32, 35, 37];
const build = (bounds: number[], rates: number[]): Bracket[] => [...bounds.map((b, i) => [b, rates[i]] as Bracket), [Infinity, rates[bounds.length]]];

/** Federal ordinary-income brackets (taxable income upper bounds) for the
 * years Mike's returns need a marginal rate. Only the filing status he used
 * that year is listed; other years show no marginal rate. */
export const BRACKETS: Record<string, Bracket[]> = {
  'single:2011': build([8500, 34500, 83600, 174400, 379150], [10, 15, 25, 28, 33, 35]),
  'single:2012': build([8700, 35350, 85650, 178650, 388350], [10, 15, 25, 28, 33, 35]),
  'single:2013': build([8925, 36250, 87850, 183250, 398350, 400000], R_PRE),
  'single:2014': build([9075, 36900, 89350, 186350, 405100, 406750], R_PRE),
  'mfj:2015': build([18450, 74900, 151200, 230450, 411500, 464850], R_PRE),
  'mfj:2016': build([18550, 75300, 151900, 231450, 413350, 466950], R_PRE),
  'mfj:2017': build([18650, 75900, 153100, 233350, 416700, 470700], R_PRE),
  'mfj:2018': build([19050, 77400, 165000, 315000, 400000, 600000], R_TCJA),
  'mfj:2019': build([19400, 78950, 168400, 321450, 408200, 612350], R_TCJA),
  'mfj:2020': build([19750, 80250, 171050, 326600, 414700, 622050], R_TCJA),
  'mfj:2021': build([19900, 81050, 172750, 329850, 418850, 628300], R_TCJA),
  'mfj:2022': build([20550, 83550, 178150, 340100, 431900, 647850], R_TCJA),
  'mfj:2023': build([22000, 89450, 190750, 364200, 462500, 693750], R_TCJA),
  'mfj:2024': build([23200, 94300, 201050, 383900, 487450, 731200], R_TCJA),
  'mfj:2025': build([23850, 96950, 206700, 394600, 501050, 751600], R_TCJA),
  'mfj:2026': build([24800, 100800, 211400, 403550, 512450, 768700], R_TCJA),
};

/** Standard deduction by status:year (what itemizing had to beat). */
export const STANDARD_DEDUCTION: Record<string, number> = {
  'single:2011': 5800,
  'single:2012': 5950,
  'single:2013': 6100,
  'single:2014': 6200,
  'mfj:2015': 12600,
  'mfj:2016': 12600,
  'mfj:2017': 12700,
  'mfj:2018': 24000,
  'mfj:2019': 24400,
  'mfj:2020': 24800,
  'mfj:2021': 25100,
  'mfj:2022': 25900,
  'mfj:2023': 27700,
  'mfj:2024': 29200,
  'mfj:2025': 31500,
  'mfj:2026': 32200,
};

/** State-and-local-tax deduction cap (married filing jointly). Before 2018
 * there was none. 2025+ cap phases down above $500K / $505K MAGI. */
export const SALT_CAP: Record<number, number> = { 2018: 10000, 2019: 10000, 2020: 10000, 2021: 10000, 2022: 10000, 2023: 10000, 2024: 10000, 2025: 40000, 2026: 40400 };
export const SALT_PHASEOUT_MAGI: Record<number, number> = { 2025: 500000, 2026: 505000 };

export interface MarginalInfo {
  rate: number;
  /** Taxable income left before the next bracket; null in the top bracket. */
  roomToNext: number | null;
  nextRate: number | null;
  nextAt: number | null;
}

export function marginalFor(status: string, year: number, taxable: number | null): MarginalInfo | null {
  const table = BRACKETS[`${status}:${year}`];
  if (!table || taxable === null) return null;
  const i = table.findIndex(([upTo]) => taxable <= upTo);
  const [upTo, rate] = table[i];
  const next = table[i + 1];
  return { rate, roomToNext: Number.isFinite(upTo) ? upTo - taxable : null, nextRate: next ? next[1] : null, nextAt: Number.isFinite(upTo) ? upTo : null };
}
