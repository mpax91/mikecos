import type { HealthWeeklyReport } from '../api/types';

export type Granularity = 'week' | 'month' | 'quarter' | 'year';

// One rolled-up period at whatever granularity is selected — a single week
// (weekCount 1) is just that week's own values; a month/quarter/year rolls
// up every imported week whose week_start falls inside it. Weeks are
// assigned to the period their *start* falls in, so a week spanning a
// month/quarter/year boundary counts toward the earlier one — simple and
// matches how Google's own report already buckets by week_start.
export interface AggregatedPeriod {
  key: string;
  label: string;
  shortLabel: string; // for chart x-axis ticks
  start: string; // earliest week_start actually covered
  end: string; // latest week_end actually covered
  weekCount: number; // weeks assigned to this period
  weeksWithData: number; // weeks that had at least a steps reading — for an honest "3 of 4 weeks tracked" footnote
  totalSteps: number | null;
  avgStepsPerDay: number | null;
  bestDaySteps: number | null;
  bestDayWeekday: string | null;
  totalMiles: number | null;
  avgCaloriesBurned: number | null;
  avgActiveZoneMinutes: number | null;
  avgRestfulSleepMinutes: number | null;
  avgHoursWith250Steps: number | null;
  avgRestingHeartRate: number | null;
  avgWeightLb: number | null; // most recent reading in the period, not an average — see buildPeriods' comment
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function bucketInfo(weekStart: string, granularity: Granularity): { key: string; label: string; shortLabel: string } {
  const d = new Date(`${weekStart}T00:00:00`);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (granularity === 'week') {
    return { key: weekStart, label: weekStart, shortLabel: weekStart };
  }
  if (granularity === 'month') {
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return { key: `${y}-${pad2(m + 1)}`, label, shortLabel: d.toLocaleDateString('en-US', { month: 'short' }) };
  }
  if (granularity === 'quarter') {
    const q = Math.floor(m / 3) + 1;
    return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, shortLabel: `Q${q} '${String(y).slice(2)}` };
  }
  return { key: `${y}`, label: `${y}`, shortLabel: `${y}` };
}

function meanNonNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function sumNonNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

function aggregateBucket(key: string, label: string, shortLabel: string, weeks: HealthWeeklyReport[]): AggregatedPeriod {
  const sorted = [...weeks].sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const start = sorted[0].week_start;
  const end = sorted[sorted.length - 1].week_end;
  const weeksWithData = sorted.filter((w) => w.total_steps != null).length;

  let bestDaySteps: number | null = null;
  let bestDayWeekday: string | null = null;
  for (const w of sorted) {
    if (w.best_day_steps != null && (bestDaySteps == null || w.best_day_steps > bestDaySteps)) {
      bestDaySteps = w.best_day_steps;
      bestDayWeekday = w.best_day_weekday;
    }
  }

  // Weight is a point-in-time reading, not something that sums or
  // meaningfully averages across weeks that may include carried-forward
  // duplicates (see the parser's comment on Google's own stale-reading
  // behavior) — the most recent reading in the period is what "your
  // weight this month" should mean, not a mean of several copies of the
  // same number.
  let avgWeightLb: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].avg_weight_lb != null) {
      avgWeightLb = sorted[i].avg_weight_lb;
      break;
    }
  }

  return {
    key,
    label,
    shortLabel,
    start,
    end,
    weekCount: sorted.length,
    weeksWithData,
    totalSteps: sumNonNull(sorted.map((w) => w.total_steps)),
    avgStepsPerDay: meanNonNull(sorted.map((w) => w.avg_steps_per_day)),
    bestDaySteps,
    bestDayWeekday,
    totalMiles: sumNonNull(sorted.map((w) => w.total_miles)),
    avgCaloriesBurned: meanNonNull(sorted.map((w) => w.avg_calories_burned)),
    avgActiveZoneMinutes: meanNonNull(sorted.map((w) => w.avg_active_zone_minutes)),
    avgRestfulSleepMinutes: meanNonNull(sorted.map((w) => w.avg_restful_sleep_minutes)),
    avgHoursWith250Steps: meanNonNull(sorted.map((w) => w.avg_hours_with_250_steps)),
    avgRestingHeartRate: meanNonNull(sorted.map((w) => w.avg_resting_heart_rate)),
    avgWeightLb,
  };
}

/** Rolls the flat weekly history up into whatever granularity is selected,
 * oldest first. A single week is passed through as-is (weekCount 1, no
 * rollup math); month/quarter/year each sum the "total_*" fields, mean the
 * "avg_*" rate fields, and take weight as the period's most recent
 * reading — see aggregateBucket's own comments for why each field is
 * combined the way it is. */
export function buildPeriods(weeks: HealthWeeklyReport[], granularity: Granularity): AggregatedPeriod[] {
  if (granularity === 'week') {
    return [...weeks]
      .sort((a, b) => (a.week_start < b.week_start ? -1 : 1))
      .map((w) => {
        const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return aggregateBucket(w.week_start, `${fmt(w.week_start)} – ${fmt(w.week_end)}`, fmt(w.week_start), [w]);
      });
  }
  const buckets = new Map<string, { label: string; shortLabel: string; weeks: HealthWeeklyReport[] }>();
  for (const w of weeks) {
    const info = bucketInfo(w.week_start, granularity);
    const existing = buckets.get(info.key);
    if (existing) existing.weeks.push(w);
    else buckets.set(info.key, { label: info.label, shortLabel: info.shortLabel, weeks: [w] });
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, { label, shortLabel, weeks: bucketWeeks }]) => aggregateBucket(key, label, shortLabel, bucketWeeks));
}

/** Looks back from `periods[idx]` for the most recent earlier period with a
 * non-null value for `field`, so a delta (week-over-week, month-over-month,
 * whatever granularity is selected) skips cleanly over a gap instead of
 * comparing against a period that has no real data — the same reasoning
 * that keeps this dashboard from trusting Google's own "vs last week"
 * text. */
export function periodDelta<K extends keyof AggregatedPeriod>(periods: AggregatedPeriod[], idx: number, field: K): number | null {
  const current = periods[idx][field];
  if (current == null) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prior = periods[i][field];
    if (prior != null) return (current as number) - (prior as number);
  }
  return null;
}
