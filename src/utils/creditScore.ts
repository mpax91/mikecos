import type { CreditScoreEntry } from '../api/types';

/** A row's average is never stored (see the migration's own comment) — it's
 * the mean of whichever of the four source columns are non-null, so old
 * rows with up to 4 sources and every new row with just CreditKarma/
 * CreditWise both average correctly without any special-casing here. */
export function entryAverage(entry: CreditScoreEntry): number | null {
  const values = [entry.creditkarma, entry.creditsesame, entry.discover_fico, entry.creditwise].filter((v): v is number => v != null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface CreditScorePoint {
  date: string; // YYYY-MM-DD
  average: number;
}

interface ChangeInfo {
  refDate: string;
  refValue: number;
  delta: number;
  deltaPct: number;
}

export interface CreditScoreSummary {
  series: CreditScorePoint[];
  latest: CreditScorePoint | null;
  monthChange: ChangeInfo | null;
  yearChange: ChangeInfo | null;
  allTimeHigh: CreditScorePoint | null;
  allTimeLow: CreditScorePoint | null;
  isNewAllTimeHigh: boolean;
  isNewAllTimeLow: boolean;
  direction: 'up' | 'down' | 'flat' | null;
  headline: string;
  detail: string;
}

export function monthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function fmtPts(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function fmtSigned(n: number, unit = ''): string {
  const rounded = Math.round(n * 10) / 10;
  const s = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${s}${unit}`;
}

/** Nearest point at least ~11 months before `date` — "this time last year"
 * against an exact 365-day lookback would miss most months since entries
 * land on the 22nd but months vary in length, so this widens to an 11-13
 * month window and picks the closest match rather than requiring an exact
 * year-ago hit. */
function findYearAgoPoint(series: CreditScorePoint[], index: number): CreditScorePoint | null {
  const target = new Date(`${series[index].date}T00:00:00`);
  target.setMonth(target.getMonth() - 12);
  let best: CreditScorePoint | null = null;
  let bestDiff = Infinity;
  for (let i = 0; i < index; i++) {
    const d = new Date(`${series[i].date}T00:00:00`);
    const diffDays = Math.abs((d.getTime() - target.getTime()) / 86400000);
    if (diffDays <= 45 && diffDays < bestDiff) {
      best = series[i];
      bestDiff = diffDays;
    }
  }
  return best;
}

/** Turns the raw entry history into everything the Credit Score Trend
 * widget needs: the plottable series, month-over-month and year-over-year
 * change, and all-time high/low — plus a short assistant-style write-up of
 * all of it, the way a person skimming their own numbers would say it back
 * to themselves ("up 7 points since last month, +6 vs. a year ago"). */
export function buildCreditScoreSummary(entries: CreditScoreEntry[]): CreditScoreSummary {
  const sorted = [...entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  const series: CreditScorePoint[] = sorted
    .map((e) => ({ date: e.entry_date, average: entryAverage(e) }))
    .filter((p): p is CreditScorePoint => p.average != null);

  if (series.length === 0) {
    return {
      series: [],
      latest: null,
      monthChange: null,
      yearChange: null,
      allTimeHigh: null,
      allTimeLow: null,
      isNewAllTimeHigh: false,
      isNewAllTimeLow: false,
      direction: null,
      headline: 'No credit score entries yet.',
      detail: 'Add this month’s CreditKarma and CreditWise scores to get started.',
    };
  }

  const latest = series[series.length - 1];
  const latestIndex = series.length - 1;

  const prev = latestIndex > 0 ? series[latestIndex - 1] : null;
  const monthChange: ChangeInfo | null = prev
    ? { refDate: prev.date, refValue: prev.average, delta: latest.average - prev.average, deltaPct: (latest.average - prev.average) / prev.average }
    : null;

  const yearAgo = findYearAgoPoint(series, latestIndex);
  const yearChange: ChangeInfo | null = yearAgo
    ? { refDate: yearAgo.date, refValue: yearAgo.average, delta: latest.average - yearAgo.average, deltaPct: (latest.average - yearAgo.average) / yearAgo.average }
    : null;

  let allTimeHigh = series[0];
  let allTimeLow = series[0];
  for (const p of series) {
    if (p.average > allTimeHigh.average) allTimeHigh = p;
    if (p.average < allTimeLow.average) allTimeLow = p;
  }

  const isNewAllTimeHigh = latest.average >= allTimeHigh.average;
  const isNewAllTimeLow = latest.average <= allTimeLow.average;

  const direction: 'up' | 'down' | 'flat' | null = monthChange == null ? null : Math.abs(monthChange.delta) < 0.05 ? 'flat' : monthChange.delta > 0 ? 'up' : 'down';

  // ---- Headline + detail, written like a quick assistant read-out ----
  let headline: string;
  if (!monthChange) {
    headline = `Your credit score is ${fmtPts(latest.average)}.`;
  } else if (direction === 'flat') {
    headline = `Your credit score held steady at ${fmtPts(latest.average)} this month.`;
  } else {
    const verb = direction === 'up' ? 'improved' : 'dipped';
    headline = `Your credit score ${verb} ${fmtPts(Math.abs(monthChange.delta))} points (${fmtSigned(monthChange.deltaPct * 100, '%')}) since last month — it's now ${fmtPts(latest.average)}.`;
  }

  const detailParts: string[] = [];
  if (yearChange) {
    const cmp = yearChange.delta > 0 ? 'better' : yearChange.delta < 0 ? 'below' : 'even with';
    const magnitude = fmtPts(Math.abs(yearChange.delta));
    detailParts.push(
      yearChange.delta === 0
        ? `That's even with this time last year (${fmtPts(yearChange.refValue)} in ${monthYear(yearChange.refDate)}).`
        : `That's ${magnitude} points ${cmp} this time last year (${fmtPts(yearChange.refValue)} in ${monthYear(yearChange.refDate)}).`
    );
  }
  if (isNewAllTimeHigh && series.length > 1) {
    detailParts.push(`🎉 That's a new all-time high.`);
  } else if (isNewAllTimeLow && series.length > 1) {
    detailParts.push(`⚠️ That's a new all-time low.`);
  } else {
    detailParts.push(`All-time high: ${fmtPts(allTimeHigh.average)} (${monthYear(allTimeHigh.date)}) · all-time low: ${fmtPts(allTimeLow.average)} (${monthYear(allTimeLow.date)}).`);
  }

  return {
    series,
    latest,
    monthChange,
    yearChange,
    allTimeHigh,
    allTimeLow,
    isNewAllTimeHigh: isNewAllTimeHigh && series.length > 1,
    isNewAllTimeLow: isNewAllTimeLow && series.length > 1,
    direction,
    headline,
    detail: detailParts.join(' '),
  };
}
