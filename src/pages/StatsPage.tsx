import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CompletionItem, StatsResponse } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTrendLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
}

/** "Sep 8, 2026 · 2:34 PM" — the exact moment, not just the day, since the
 * whole point of this list is answering "when did I actually do that". */
function formatCompletedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const PAGE_SIZE = 50;

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
 * Rollup totals + a 14-day trend, plus (added after Mike asked to actually
 * find a specific past completion — "when did I call Kia") a searchable,
 * newest-first list of the raw completion log itself. Still no editing and
 * nothing that turns this into a second task list — checking things off
 * stays on Day/Week/Month; this page is purely a record of what already
 * happened. */
export function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [completions, setCompletions] = useState<CompletionItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const requestId = useRef(0);

  useReportTabMeta('Stats', 'stats');

  useEffect(() => {
    api
      .getStats(todayLocalISO())
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, []);

  const loadCompletions = useCallback((q: string) => {
    const myRequest = ++requestId.current;
    setListLoading(true);
    api
      .getCompletions({ q: q || undefined, limit: PAGE_SIZE })
      .then((res) => {
        if (myRequest !== requestId.current) return; // a newer search superseded this one
        setCompletions(res.completions);
        setHasMore(res.has_more);
        setListError(null);
      })
      .catch((e) => {
        if (myRequest !== requestId.current) return;
        setListError(String(e));
      })
      .finally(() => {
        if (myRequest === requestId.current) setListLoading(false);
      });
  }, []);

  // Debounced so typing doesn't fire a request per keystroke; requestId
  // above still guards against an in-flight older search landing after a
  // newer one even if two happen to overlap.
  useEffect(() => {
    const t = window.setTimeout(() => loadCompletions(query), 300);
    return () => window.clearTimeout(t);
  }, [query, loadCompletions]);

  function loadMore() {
    if (!completions || completions.length === 0) return;
    const before = completions[completions.length - 1].completed_at;
    setListLoading(true);
    api
      .getCompletions({ q: query || undefined, before, limit: PAGE_SIZE })
      .then((res) => {
        setCompletions((prev) => [...(prev ?? []), ...res.completions]);
        setHasMore(res.has_more);
      })
      .catch((e) => setListError(String(e)))
      .finally(() => setListLoading(false));
  }

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
            <div className="stats-page__section-title">Last 14 Days</div>
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

          <div className="stats-page__section">
            <div className="stats-page__section-title-row">
              <div className="stats-page__section-title">Completed Tasks</div>
              <input
                type="text"
                className="stats-page__search"
                placeholder="Search completed tasks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {listError ? (
              <div className="empty-state">Couldn't load completion history: {listError}</div>
            ) : completions === null ? (
              <div className="empty-state">Loading…</div>
            ) : completions.length === 0 ? (
              <div className="empty-state">
                {query ? `No completed tasks match "${query}".` : 'Nothing completed yet — check one off to see it here.'}
              </div>
            ) : (
              <>
                <div className="stats-page__completions card">
                  {completions.map((item) => (
                    <div key={item.id} className="stats-page__completion-row">
                      <span className="stats-page__completion-title">{item.title || 'Untitled Task'}</span>
                      <span className="stats-page__completion-date">{formatCompletedAt(item.completed_at)}</span>
                    </div>
                  ))}
                </div>
                {hasMore && (
                  <button type="button" className="btn btn--ghost stats-page__load-more" onClick={loadMore} disabled={listLoading}>
                    {listLoading ? 'Loading…' : 'Load More'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
