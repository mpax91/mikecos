/** Social Security program numbers used by the benefit math (ssa/projection.ts).
 * Published by SSA's Office of the Chief Actuary — checked 2026-10-19:
 *   AWI          ssa.gov/oact/cola/AWI.html        (national average wage index)
 *   Wage base    ssa.gov/oact/cola/cbb.html        (contribution & benefit base)
 *   Bend points  ssa.gov/oact/cola/bendpoints.html (PIA formula, by year of eligibility)
 * Add a year each October, when SSA announces the next year's COLA, wage
 * base and bend points (the AWI for two years back comes out then too). If a
 * year is missing the math falls back to the latest one listed. */

export const AWI: Record<number, number> = {
  1985: 16822.51, 1986: 17321.82, 1987: 18426.51, 1988: 19334.04, 1989: 20099.55,
  1990: 21027.98, 1991: 21811.6, 1992: 22935.42, 1993: 23132.67, 1994: 23753.53,
  1995: 24705.66, 1996: 25913.9, 1997: 27426.0, 1998: 28861.44, 1999: 30469.84,
  2000: 32154.82, 2001: 32921.92, 2002: 33252.09, 2003: 34064.95, 2004: 35648.55,
  2005: 36952.94, 2006: 38651.41, 2007: 40405.48, 2008: 41334.97, 2009: 40711.61,
  2010: 41673.83, 2011: 42979.61, 2012: 44321.67, 2013: 44888.16, 2014: 46481.52,
  2015: 48098.63, 2016: 48642.15, 2017: 50321.89, 2018: 52145.8, 2019: 54099.99,
  2020: 55628.6, 2021: 60575.07, 2022: 63795.13, 2023: 66621.8, 2024: 69846.57,
  2025: 72800.33,
};

/** Maximum earnings taxed for Social Security each year. */
export const WAGE_BASE: Record<number, number> = {
  1985: 39600, 1986: 42000, 1987: 43800, 1988: 45000, 1989: 48000,
  1990: 51300, 1991: 53400, 1992: 55500, 1993: 57600, 1994: 60600,
  1995: 61200, 1996: 62700, 1997: 65400, 1998: 68400, 1999: 72600,
  2000: 76200, 2001: 80400, 2002: 84900, 2003: 87000, 2004: 87900,
  2005: 90000, 2006: 94200, 2007: 97500, 2008: 102000, 2009: 106800,
  2010: 106800, 2011: 106800, 2012: 110100, 2013: 113700, 2014: 117000,
  2015: 118500, 2016: 118500, 2017: 127200, 2018: 128400, 2019: 132900,
  2020: 137700, 2021: 142800, 2022: 147000, 2023: 160200, 2024: 168600,
  2025: 176100, 2026: 184500, 2027: 192300,
};

/** PIA bend points by year of eligibility (the year you turn 62). */
export const BEND_POINTS: Record<number, [number, number]> = {
  2009: [744, 4483], 2010: [761, 4586], 2011: [749, 4517], 2012: [767, 4624],
  2013: [791, 4768], 2014: [816, 4917], 2015: [826, 4980], 2016: [856, 5157],
  2017: [885, 5336], 2018: [895, 5397], 2019: [926, 5583], 2020: [960, 5785],
  2021: [996, 6002], 2022: [1024, 6172], 2023: [1115, 6721], 2024: [1174, 7078],
  2025: [1226, 7391], 2026: [1286, 7749], 2027: [1340, 8077],
};

export const OASDI_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;

const latestKey = (t: Record<number, unknown>) => Math.max(...Object.keys(t).map(Number));

export function awiFor(year: number): number {
  return AWI[year] ?? AWI[Math.min(year, latestKey(AWI))] ?? AWI[latestKey(AWI)];
}
export function wageBaseFor(year: number): number {
  return WAGE_BASE[year] ?? WAGE_BASE[latestKey(WAGE_BASE)];
}
export function bendPointsFor(year: number): [number, number] {
  return BEND_POINTS[year] ?? BEND_POINTS[Math.min(year, latestKey(BEND_POINTS))] ?? BEND_POINTS[latestKey(BEND_POINTS)];
}
/** The latest year with a published AWI. */
export const LATEST_AWI_YEAR = latestKey(AWI);
