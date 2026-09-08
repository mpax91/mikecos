import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { StatsResponse } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTrendLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
}

interface SummaryCardDef {
  label: string;
  value: number;
}

/** A momentum check, not a to-do list — this page is deliberately just "how
 * much did I get done", pulled from the append-only completion log (see the
 * worker's /api/stats comment for why a dedicated log beats querying
 * entities.status directly: a task's status can flip back, or the row can
 * be edited/deleted later, without that erasing the fact that it *was*
 * finished on a given day). Mike asked for this after noticing a completed
 * task just "vanished" with no record it ever happened.
 *
 * Deliberately simple for this first pass: four rollup totals anchored on
 * today, plus a 14-day bar trend. No per-task breakdown, no editing,
 * nothing that turns this into a second task list — that's what Day/Week/
 * Month are for. */
export function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useReportTabMeta('Stats', 'stats');

  useEffect(() => {
    api
      .getStats(todayLocalISO())
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="empty-state">Couldn't load stats: {error}</div>;

  const cards: SummaryCardDef[] = stats
    ? [
        { label: 'Today', value: stats.today },
        { label: 'This week', value: stats.week },
        { label: 'This month', value: stats.month },
        { label: 'This year', value: stats.year },
      ]
    : [];

  const maxTrend = stats ? Math.max(1, ...stats.trend.map((t) => t.count)) : 1;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Stats
        </h1>
      </div>

      {stats === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="stats-page">
          <div className="stats-page__summary">
            {cards.map((c) => (
              <div key={c.label} className="stats-page__card card">
                <div className="stats-page__card-value">{c.value}</div>
                <div className="stats-page__card-label">{c.label}</div>
              </div>
            ))}
          </div>

          <div className="stats-page__section">
            <div className="stats-page__section-title">Last 14 days</div>
            {stats.trend.every((t) => t.count === 0) ? (
              <div className="empty-state">Nothing completed yet in this window — check one off to get started.</div>
            ) : (
              <div className="stats-page__trend card">
                {stats.trend.map((t) => (
                  <div key={t.date} className="stats-page__trend-col" title={`${t.count} completed`}>
                    <div className="stats-page__trend-count">{t.count > 0 ? t.count : ''}</div>
                    <div
                      className="stats-page__trend-bar"
                      style={{ height: `${Math.max(2, (t.count / maxTrend) * 100)}px` }}
                    />
                    <div className="stats-page__trend-date">{formatTrendLabel(t.date)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
