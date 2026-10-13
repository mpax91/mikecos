import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { PersonWork, WorkTask } from '../api/types';
import { openMeetingSheet } from './MeetingSheet';
import type { MeetingItem } from '../api/types';

/** Contact card bar: what's open between Mike and this person (tasks with
 * them, Waiting items on them, undecided next steps from meeting notes),
 * the meetings they're on, and recent meeting notes. Hidden when there's
 * nothing. */

const TZ = 'America/New_York';
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const fmtYmd = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
function fmtDue(d: string | null) {
  if (!d) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PersonWorkSection({ contactId, firstName, fullName }: { contactId: string; firstName: string; fullName?: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<PersonWork | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.getPersonWork(contactId).then(setData).catch(() => setData(null));
  }, [contactId]);

  if (!data) return null;
  const learned = data.learned ?? [];
  const empty = !data.iOwe.length && !data.theyOwe.length && !data.pendingActions.length && !data.series.length && !data.recentMeetings.length && !data.upcoming.length && !learned.length;
  if (empty) return null;

  const next = data.upcoming[0];
  const bits = [
    data.iOwe.length ? `You owe ${data.iOwe.length}` : '',
    data.theyOwe.length ? `Waiting on ${data.theyOwe.length}` : '',
    next ? `Next: ${next.title} ${fmtDay(next.start)}` : '',
    !data.iOwe.length && !data.theyOwe.length && !next && learned.length ? `${learned.length} thing${learned.length === 1 ? '' : 's'} learned` : '',
  ].filter(Boolean);

  const openTask = (t: WorkTask) => (t.waiting_source_id ? navigate('/waiting') : t.due_date ? navigate(`/today/${t.due_date}`) : navigate('/today'));
  const list = (items: WorkTask[]) => (
    <ul className="mtg-tasks">
      {items.map((t) => (
        <li key={t.id} className="mtg-task">
          <button type="button" className="mtg-task__btn" onClick={() => openTask(t)}>
            <span className="mtg-task__title">{t.title.replace(/^Check Back: /, '').replace(fullName ? ` (${fullName})` : /$^/, '')}</span>
            {t.blocked_reason != null && <span className="mtg-pill mtg-pill--blocked">Blocked</span>}
            {t.due_date && <span className="mtg-task__due">{fmtDue(t.due_date)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={`voter-insight person-work${open ? ' is-open' : ''}`}>
      <button type="button" className="voter-insight__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="voter-insight__caret" aria-hidden>
          ›
        </span>
        <span className="voter-insight__title">Meetings &amp; Open Items</span>
        <span className="voter-insight__summary">
          <span className="comms-contact__last">{bits.join(' · ') || 'Nothing open'}</span>
        </span>
        <span className="voter-insight__toggle">{open ? 'Hide Details' : 'Show Details'}</span>
      </button>
      {open && (
        <div className="voter-insight__card">
          <div className="voter-insight__body person-work__body">
            {data.iOwe.length > 0 && (
              <div>
                <div className="voter-insight__group-title">You Owe {firstName}</div>
                {list(data.iOwe)}
              </div>
            )}
            {data.theyOwe.length > 0 && (
              <div>
                <div className="voter-insight__group-title">Waiting On {firstName}</div>
                {list(data.theyOwe)}
              </div>
            )}
            {data.pendingActions.length > 0 && (
              <div>
                <div className="voter-insight__group-title">Next Steps Not Sorted Yet</div>
                <ul className="mtg-tasks">
                  {data.pendingActions.map((a) => (
                    <li key={a.id} className="mtg-task">
                      <span className="mtg-task__title">{a.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {learned.length > 0 && (
              <div>
                <div className="voter-insight__group-title">What I've Learned</div>
                <ul className="person-learned">
                  {learned.slice(0, 12).map((l) => (
                    <li key={l.id}>
                      <span className="person-learned__fact">{l.fact}</span>
                      <span className="person-learned__src">
                        {fmtYmd(l.date)}
                        {l.title ? ` · ${l.title}` : ''}
                      </span>
                      <button
                        type="button"
                        className="person-learned__x"
                        title="Forget this"
                        aria-label="Forget this"
                        onClick={async () => {
                          await api.deleteContactContext(l.id);
                          setData((d) => (d ? { ...d, learned: (d.learned ?? []).filter((x) => x.id !== l.id) } : d));
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.upcoming.length > 0 && (
              <div>
                <div className="voter-insight__group-title">Upcoming Meetings</div>
                <ul className="mtg-tasks">
                  {data.upcoming.map((m) => (
                    <li key={m.id} className="mtg-task">
                      <button
                        type="button"
                        className="mtg-task__btn"
                        onClick={() => openMeetingSheet({ ...(m as unknown as MeetingItem), calendar: '', gcalUrl: null, attendees: [], location: null, links: [], hasNote: false })}
                      >
                        <span className="mtg-task__title">{m.title}</span>
                        <span className="mtg-task__due">{m.allDay ? fmtDay(m.start) : fmtWhen(m.start)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.recentMeetings.length > 0 && (
              <div>
                <div className="voter-insight__group-title">Recent Meeting Notes</div>
                {data.recentMeetings.map((s) => (
                  <div key={s.id} className="mtg-past">
                    <div className="mtg-past__date">
                      {fmtDay(s.start)} · {s.title}
                    </div>
                    {s.tldr?.length ? (
                      <ul className="mtg-tldr">
                        {s.tldr.slice(0, 3).map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    ) : (
                      s.summary && <p className="mtg-summary__text">{s.summary.length > 260 ? s.summary.slice(0, 260) + '…' : s.summary}</p>
                    )}
                    {s.noteEntityId && (
                      <Link className="mtg-link" to={`/notes/${s.noteEntityId}`}>
                        {s.source === 'record' ? 'Full brief →' : 'Full notes →'}
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
            {data.series.length > 0 && (
              <div className="person-work__series">
                On:{' '}
                {data.series.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ', '}
                    <Link to={`/settings?cat=meetings&series=${s.id}`}>{s.title}</Link>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
