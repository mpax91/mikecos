import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { WaitingItem, WaitingList } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Plan → Waiting For: everything Mike handed to someone else and is
 * checking back on (created from the follow-up toast when a task is
 * checked off). Each follow-up is an ordinary task due on its check-back
 * date, so it also shows on Today and the Calendar. */

const PREFIX = 'Check Back: ';
const todayIso = () => new Date().toLocaleDateString('en-CA');
const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmt = (iso: string | null) => (iso ? toDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—');
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);
const shift = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};
const label = (w: WaitingItem) => (w.title.startsWith(PREFIX) ? w.title.slice(PREFIX.length) : w.title);

export function WaitingPage() {
  useReportTabMeta('Waiting For', 'waiting');
  const [data, setData] = useState<WaitingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReceived, setShowReceived] = useState(false);

  const load = useCallback(() => {
    api
      .listWaiting()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const today = todayIso();

  async function gotIt(w: WaitingItem) {
    setData((d) => (d ? { ...d, open: d.open.filter((x) => x.id !== w.id) } : d));
    await api.updateEntity(w.id, { status: 'done' }, { quiet: true });
    load();
  }
  async function moveTo(w: WaitingItem, due: string) {
    setData((d) => (d ? { ...d, open: d.open.map((x) => (x.id === w.id ? { ...x, dueDate: due } : x)).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')) } : d));
    await api.updateEntity(w.id, { due_date: due });
  }
  async function reopen(w: WaitingItem) {
    await api.updateEntity(w.id, { status: 'open' });
    load();
  }
  async function remove(w: WaitingItem) {
    setData((d) => (d ? { ...d, open: d.open.filter((x) => x.id !== w.id) } : d));
    await api.deleteEntity(w.id);
    load();
  }

  return (
    <div className="waiting-page">
      <div className="links-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Waiting For
        </h1>
      </div>
      <p className="links-page__subhead">Things you’ve handed off and are checking back on. Check off a task anywhere and choose “Remind Me” to add one.</p>

      {error && <div className="empty-state">Couldn’t load Waiting For: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && data.open.length === 0 && (
        <div className="empty-state">Nothing you’re waiting on. When you check off a task, tap “Remind Me” on the pop-up to follow up later.</div>
      )}

      {data && data.open.length > 0 && (
        <ul className="waiting-list">
          {data.open.map((w) => {
            const due = w.dueDate ?? today;
            const late = due < today;
            const isToday = due === today;
            const waited = w.since ? daysBetween(w.since, today) : null;
            return (
              <li key={w.id} className={`waiting-item${late ? ' is-late' : isToday ? ' is-today' : ''}`}>
                <div className="waiting-item__main">
                  <div className="waiting-item__title">{label(w)}</div>
                  <div className="waiting-item__meta">
                    {w.since && `Since ${fmt(w.since)}${waited !== null ? ` (${waited === 0 ? 'today' : `${waited} day${waited === 1 ? '' : 's'}`})` : ''}`}
                    {w.sourceParentId && w.sourceParentTitle && w.sourceParentType === 'project' && (
                      <>
                        {' · '}
                        <Link to={`/projects/${w.sourceParentId}`}>{w.sourceParentTitle}</Link>
                      </>
                    )}
                  </div>
                </div>
                <div className="waiting-item__when">
                  <button type="button" className="follow-toast__step waiting-item__step" aria-label="One day sooner" onClick={() => moveTo(w, shift(due, -1))}>
                    −
                  </button>
                  <span className={`waiting-item__due${late ? ' is-late' : ''}`}>{late ? `Overdue · ${fmt(due)}` : isToday ? 'Today' : fmt(due)}</span>
                  <button type="button" className="follow-toast__step waiting-item__step" aria-label="One day later" onClick={() => moveTo(w, shift(due, 1))}>
                    +
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" title="Check back a week from today" onClick={() => moveTo(w, shift(today, 7))}>
                    +1 Week
                  </button>
                </div>
                <div className="waiting-item__actions">
                  <button type="button" className="btn btn--sm" onClick={() => gotIt(w)}>
                    Got It
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" title="Stop waiting (delete)" aria-label="Stop waiting" onClick={() => remove(w)}>
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data && data.received.length > 0 && (
        <div className="waiting-received">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowReceived((v) => !v)}>
            {showReceived ? '▾' : '▸'} Received (Last 30 Days) · {data.received.length}
          </button>
          {showReceived && (
            <ul className="waiting-list waiting-list--done">
              {data.received.map((w) => (
                <li key={w.id} className="waiting-item is-done">
                  <div className="waiting-item__main">
                    <div className="waiting-item__title">{label(w)}</div>
                    <div className="waiting-item__meta">
                      {w.since && `Asked ${fmt(w.since)} · `}Received {fmt(w.updatedAt.slice(0, 10))}
                    </div>
                  </div>
                  <div className="waiting-item__actions">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => reopen(w)}>
                      Still Waiting
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
