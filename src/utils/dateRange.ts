/** Date ranges for dashboards. Dates are YYYY-MM-DD (inclusive), local to
 * America/New_York — compare with each item's own local day. */
export type RangeKey = '7d' | '28d' | '90d' | 'ytd' | '1y' | 'all' | 'custom';
export interface DateRange {
  key: RangeKey;
  from: string;
  to: string;
  label: string;
}
export const RANGE_LABEL: Record<RangeKey, string> = { '7d': '7D', '28d': '28D', '90d': '90D', ytd: 'YTD', '1y': '1Y', all: 'All', custom: 'Custom' };

const DAY = 86400000;
const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY) + 1;

/** Today's date in New York. */
export function nyToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
/** An ISO timestamp's New York calendar day. */
export function nyDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function resolveRange(key: RangeKey, today: string, earliest: string): DateRange {
  const n = key === '7d' ? 7 : key === '28d' ? 28 : key === '90d' ? 90 : 0;
  if (n) return { key, from: addDays(today, -(n - 1)), to: today, label: `Last ${n} days` };
  if (key === 'ytd') return { key, from: `${today.slice(0, 4)}-01-01`, to: today, label: 'Year to date' };
  if (key === '1y') return { key, from: addDays(today, -364), to: today, label: 'Last 12 months' };
  return { key: 'all', from: earliest, to: today, label: 'All time' };
}

/** The same-length stretch right before `r` (null for All time). For YTD it
 * is last year's same dates — the fair comparison. */
export function previousRange(r: DateRange): { from: string; to: string; label: string } | null {
  if (r.key === 'all') return null;
  if (r.key === 'ytd') {
    const y = +r.from.slice(0, 4) - 1;
    return { from: `${y}-01-01`, to: `${y}${r.to.slice(4)}`, label: `same dates ${y}` };
  }
  const len = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -len), to: addDays(r.from, -1), label: r.key === 'custom' ? `prior ${len} days` : `prior ${RANGE_LABEL[r.key]}` };
}

export const inRange = (day: string, r: { from: string; to: string }) => day >= r.from && day <= r.to;

/** Human label for a range, e.g. "Sep 14 – Oct 11, 2026". */
export function rangeText(r: { from: string; to: string }): string {
  const f = new Date(`${r.from}T12:00:00`);
  const t = new Date(`${r.to}T12:00:00`);
  const sameYear = f.getFullYear() === t.getFullYear();
  const a = f.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const b = t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${a} – ${b}`;
}

/** Bucket size for a trend chart over a range. */
export function bucketFor(r: { from: string; to: string }): 'day' | 'week' | 'month' {
  const n = daysBetween(r.from, r.to);
  return n <= 45 ? 'day' : n <= 400 ? 'week' : 'month';
}
/** Start day of the bucket a day falls in (weeks start Monday). */
export function bucketStart(day: string, b: 'day' | 'week' | 'month'): string {
  if (b === 'day') return day;
  if (b === 'month') return `${day.slice(0, 7)}-01`;
  const dow = new Date(toMs(day)).getUTCDay(); // 0 Sun
  return addDays(day, -((dow + 6) % 7));
}
/** Every bucket start in a range, in order (so empty buckets show as 0). */
export function bucketsIn(r: { from: string; to: string }, b: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  let d = bucketStart(r.from, b);
  while (d <= r.to) {
    out.push(d);
    d = b === 'day' ? addDays(d, 1) : b === 'week' ? addDays(d, 7) : `${+d.slice(5, 7) === 12 ? +d.slice(0, 4) + 1 : d.slice(0, 4)}-${String((+d.slice(5, 7) % 12) + 1).padStart(2, '0')}-01`;
  }
  return out;
}
export const dayMs = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).getTime();
};
