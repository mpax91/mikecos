import type { HabitSummary } from '../api/types';

/** A tiny inline 14-day sparkline — no charting library, just a scaled
 * polyline. Shared between the Habits capture page and its Dashboard card
 * so the two views of the same data look identical. Direction only affects
 * which color the endpoint dot gets (good vs. needs-work), never the shape
 * of the line — the line is just magnitude. */
export function HabitSparkline({ summary }: { summary: HabitSummary }) {
  const values = summary.series.map((d) => d.total);
  const max = Math.max(1, ...values);
  const w = 120;
  const h = 28;
  const step = w / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(' ');
  const last = summary.today;
  const prev = summary.series[summary.series.length - 2]?.total ?? last;
  const good = summary.habit.direction === 'reduce' ? last <= prev : last >= prev;
  const lastX = (values.length - 1) * step;
  const lastY = h - (last / max) * (h - 4) - 2;

  return (
    <svg className="habits-page__sparkline" viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.4} />
      <circle cx={lastX} cy={lastY} r={2.5} fill={good ? 'var(--color-success, #2f7a4f)' : 'var(--color-danger, #c0392b)'} />
    </svg>
  );
}
