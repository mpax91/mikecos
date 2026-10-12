import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { WeekBrief, WorkTask } from '../api/types';
import { DetailSheet } from './dash/DetailSheet';

/** Dashboard in Work mode: this week at Birches at a glance. Every tile opens
 * the items behind it. Built from the same data as the weekly briefs. */

function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function fmt(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const clean = (t: WorkTask) => {
  let s = t.title.replace(/^Check Back: /, '');
  if (t.contactName && s.endsWith(` (${t.contactName})`)) s = s.slice(0, -(t.contactName.length + 3));
  return `${t.contactName ? `${t.contactName}: ` : ''}${s}`;
};

type TileKey = 'done' | 'due' | 'overdue' | 'blocked' | 'waiting' | 'pushed';

export function WorkDashboard() {
  const navigate = useNavigate();
  const [b, setB] = useState<WeekBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<TileKey | null>(null);

  useEffect(() => {
    api.getWeekBrief(mondayOf()).then(setB).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="empty-state">Couldn't load: {error}</div>;
  if (!b) return <div className="empty-state">Loading…</div>;

  const dueOpen = b.dueThisWeek;
  const pushed = [...b.pushed, ...b.slipped];
  const tiles: { key: TileKey; label: string; value: number; sub: string; items: WorkTask[] }[] = [
    { key: 'done', label: 'Done This Week', value: b.done.length, sub: `${b.received.length} received`, items: b.done },
    { key: 'due', label: 'Due This Week', value: dueOpen.length, sub: 'still open', items: dueOpen },
    { key: 'overdue', label: 'Carried Over', value: b.overdue.length, sub: 'from before this week', items: b.overdue },
    { key: 'blocked', label: 'Blocked', value: b.blocked.length, sub: 'marked blocked', items: b.blocked },
    { key: 'waiting', label: 'Waiting On', value: b.waiting.length, sub: 'others owe you', items: b.waiting },
    { key: 'pushed', label: 'Pushed', value: pushed.length, sub: 'moved or slipped', items: pushed },
  ];
  const active = tiles.find((t) => t.key === open);

  return (
    <div className="work-dash">
      <div className="work-dash__range">
        This week · {fmt(b.week)} – {fmt(b.weekEnd)} · {b.meetingHours} h in {b.meetings.length} meeting{b.meetings.length === 1 ? '' : 's'}
        {b.pendingActions > 0 && ` · ${b.pendingActions} next step${b.pendingActions === 1 ? '' : 's'} from meetings to sort`}
      </div>
      <div className="work-dash__tiles">
        {tiles.map((t) => (
          <button key={t.key} type="button" className={`work-dash__tile${t.key === 'blocked' && t.value ? ' is-warn' : ''}`} onClick={() => setOpen(t.key)}>
            <span className="fin-dash__stat-label">{t.label}</span>
            <span className="fin-dash__stat-value">{t.value}</span>
            <span className="fin-dash__stat-sub">{t.sub}</span>
          </button>
        ))}
      </div>
      <div className="work-dash__links">
        <Link className="btn btn--ghost btn--sm" to="/briefs?kind=ahead">
          🧭 Plan the Week
        </Link>
        <Link className="btn btn--ghost btn--sm" to="/briefs?kind=review">
          📋 Weekly Review
        </Link>
      </div>

      {active && (
        <DetailSheet title={active.label} sub={`${active.value} · ${fmt(b.week)} – ${fmt(b.weekEnd)}`} onClose={() => setOpen(null)}>
          {active.items.length === 0 ? (
            <div className="empty-state">Nothing here.</div>
          ) : (
            <ul className="brief__list">
              {active.items.map((t, i) => (
                <li key={t.id + i} className="brief__item">
                  <button
                    type="button"
                    className="brief__item-btn"
                    onClick={() => {
                      setOpen(null);
                      if (t.waiting_since) navigate('/waiting');
                      else if (t.project) navigate(`/projects/${t.project.id}`, { state: { openId: t.id } });
                      else navigate(t.due_date ? `/today/${t.due_date}` : '/today');
                    }}
                  >
                    <span className="brief__item-title">
                      {clean(t)}
                      {t.blocked_reason ? ` — ${t.blocked_reason}` : ''}
                    </span>
                    {t.project && <span className="brief__item-project">{t.project.title}</span>}
                    {t.due_date && <span className="brief__item-project">{fmt(t.due_date)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DetailSheet>
      )}
    </div>
  );
}
