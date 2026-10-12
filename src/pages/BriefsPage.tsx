import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { MeetingItem, WeekBrief, WeekReview, WorkTask } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { useRealm } from '../contexts/RealmContext';
import { SectionPicker } from '../components/dash/SectionPicker';
import { InfoTip } from '../components/dash/InfoTip';
import { openMeetingSheet, MEETING_CHANGED_EVENT } from '../components/MeetingSheet';
import { RealmChip } from '../components/RealmSwitch';

/** Briefs: the Monday "Week Ahead" (what to work on) and the Friday "Week in
 * Review" (done, pushed, blocked, waiting, Start / Stop / Continue) — built
 * from MikeOS's own tasks, meetings and Waiting items, rule-based. Follows
 * the All / Personal / Work switch; Copy for Slack / Email gives a version
 * ready to send to a boss or team. */

type Kind = 'ahead' | 'review';
const KINDS = [
  ['ahead', 'Week Ahead'],
  ['review', 'Week in Review'],
] as const;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function mondayOf(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return addDays(iso, -((new Date(y, m - 1, d).getDay() + 6) % 7));
}
function fmt(iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}
const weekday = (iso: string) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
const TZ = 'America/New_York';
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const clean = (t: string) => t.replace(/^Check Back: /, '');
/** "Sarah Chen: Send the deck" — without the "(Sarah Chen)" a check-back title carries. */
const waitLabel = (t: WorkTask) => {
  let s = clean(t.title);
  if (t.contactName && s.endsWith(` (${t.contactName})`)) s = s.slice(0, -(t.contactName.length + 3));
  return `${t.contactName ? `${t.contactName}: ` : ''}${s}`;
};

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m.entries()];
}

// ---- Copy text --------------------------------------------------------

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

function briefText(b: WeekBrief, kind: Kind, style: 'slack' | 'email'): string {
  const H = (s: string) => (style === 'slack' ? `*${s}*` : s.toUpperCase());
  const li = (s: string) => (style === 'slack' ? `• ${s}` : `- ${s}`);
  const range = `${fmt(b.week)} – ${fmt(addDays(b.week, 4))}`;
  const out: string[] = [];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push('', H(title), ...items.map(li));
  };
  const proj = (t: WorkTask) => (t.project ? `${t.project.title}: ` : '');
  if (kind === 'ahead') {
    out.push(H(`Week Ahead · ${range}`));
    section('Top Priorities', lines(b.review.priorities));
    section(
      'Due This Week',
      b.dueThisWeek.map((t) => `${proj(t)}${t.title} (${fmt(t.due_date!, { weekday: 'short' })})`)
    );
    section('Carried Over', b.overdue.map((t) => `${proj(t)}${t.title} (was due ${fmt(t.due_date!)})`));
    section(
      'Key Meetings',
      b.meetings.filter((m) => !m.allDay).map((m) => `${fmt(m.date, { weekday: 'short' })} ${fmtTime(m.start)} · ${m.title}${m.people.length ? ` (${m.people.map((p) => p.name.split(' ')[0]).join(', ')})` : ''}`)
    );
    section('Blocked', b.blocked.map((t) => `${t.title}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`));
    section('Waiting On', b.waiting.map((t) => waitLabel(t)));
  } else {
    out.push(H(`Week in Review · ${range}`));
    section('Highlights', lines(b.review.highlights));
    const doneGroups = groupBy(b.done, (t) => t.project?.title ?? '');
    section(
      `Accomplished (${b.done.length})`,
      doneGroups.flatMap(([p, ts]) => (p ? [`${p}: ${ts.map((t) => t.title).join('; ')}`] : ts.map((t) => t.title)))
    );
    section(
      'Pushed',
      [...b.pushed.map((t) => `${proj(t)}${t.title} → ${t.due_date ? fmt(t.due_date) : 'later'}${(t.totalPushes ?? 1) > 1 ? ` (pushed ${t.totalPushes}×)` : ''}`), ...b.slipped.map((t) => `${proj(t)}${t.title} (was due ${fmt(t.due_date!)})`)]
    );
    section('Blocked', b.blocked.map((t) => `${t.title}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`));
    section('Waiting On', b.waiting.map((t) => `${waitLabel(t)}${t.waiting_since ? ` (since ${fmt(t.waiting_since)})` : ''}`));
    const ssc = [
      ...lines(b.review.start).map((l) => `Start: ${l}`),
      ...lines(b.review.stop).map((l) => `Stop: ${l}`),
      ...lines(b.review.continue).map((l) => `Continue: ${l}`),
    ];
    section('Start / Stop / Continue', ssc);
    section('Next Week', b.dueNextWeek.slice(0, 10).map((t) => `${proj(t)}${t.title} (${fmt(t.due_date!, { weekday: 'short' })})`));
  }
  return out.join('\n').trim();
}

// ---- UI pieces --------------------------------------------------------

function TaskList({ items, empty, render }: { items: WorkTask[]; empty: string; render?: (t: WorkTask) => React.ReactNode }) {
  const navigate = useNavigate();
  if (!items.length) return <div className="brief__empty">{empty}</div>;
  return (
    <ul className="brief__list">
      {items.map((t) => (
        <li key={t.id} className="brief__item">
          <button
            type="button"
            className="brief__item-btn"
            onClick={() => (t.waiting_since ? navigate('/waiting') : t.project ? navigate(`/projects/${t.project.id}`, { state: { openId: t.id } }) : t.due_date ? navigate(`/today/${t.due_date}`) : navigate('/today'))}
          >
            <span className="brief__item-title">{render ? render(t) : clean(t.title)}</span>
            {t.project && <span className="brief__item-project">{t.project.title}</span>}
            <RealmChip realm={t.realm} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, count, info, children, tone }: { title: string; count?: number; info?: string; children: React.ReactNode; tone?: string }) {
  return (
    <section className={`brief__card card${tone ? ` brief__card--${tone}` : ''}`}>
      <div className="brief__card-head">
        <h3>
          {title}
          {count !== undefined && <span className="brief__count">{count}</span>}
        </h3>
        {info && <InfoTip>{info}</InfoTip>}
      </div>
      {children}
    </section>
  );
}

function ReviewBox({ label, value, placeholder, onSave, suggestions }: { label: string; value: string; placeholder: string; onSave: (v: string) => void; suggestions?: string[] }) {
  const [v, setV] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    setV(value);
    last.current = value;
  }, [value]);
  const commit = (next: string) => {
    if (next === last.current) return;
    last.current = next;
    onSave(next);
  };
  return (
    <div className="brief__review">
      <div className="brief__review-label">{label}</div>
      <textarea rows={3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v)} />
      {suggestions && suggestions.length > 0 && (
        <div className="brief__suggest">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="brief__suggest-chip"
              title="Add this"
              onClick={() => {
                const next = v.trim() ? `${v.trim()}\n- ${s}` : `- ${s}`;
                setV(next);
                commit(next);
              }}
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BriefsPage() {
  useReportTabMeta('Briefs', 'briefs');
  const { realm } = useRealm();
  const [params, setParams] = useSearchParams();
  const today = todayISO();
  const week = params.get('week') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('week')!) ? mondayOf(params.get('week')!) : mondayOf(today);
  const defaultKind: Kind = week < mondayOf(today) ? 'review' : week > mondayOf(today) ? 'ahead' : [4, 5, 6, 0].includes(new Date().getDay()) ? 'review' : 'ahead';
  const kind = (params.get('kind') as Kind) || defaultKind;
  const [brief, setBrief] = useState<WeekBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getWeekBrief(week)
      .then((b) => {
        setBrief(b);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [week]);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener(MEETING_CHANGED_EVENT, load);
    return () => window.removeEventListener(MEETING_CHANGED_EVENT, load);
  }, [load]);

  function go(patch: { week?: string; kind?: Kind }) {
    const next = new URLSearchParams(params);
    if (patch.week) next.set('week', patch.week);
    if (patch.kind) next.set('kind', patch.kind);
    setParams(next, { replace: true });
  }

  async function saveReview(patch: Partial<WeekReview>) {
    setBrief((b) => (b ? { ...b, review: { ...b.review, ...patch } } : b));
    await api.saveWeekReview(week, patch).catch(() => undefined);
  }

  async function copy(style: 'slack' | 'email') {
    if (!brief) return;
    const text = briefText(brief, kind, style);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(style);
    window.setTimeout(() => setCopied(null), 1800);
  }

  const mailto = useMemo(() => {
    if (!brief) return '#';
    const subject = `${kind === 'ahead' ? 'Week Ahead' : 'Week in Review'} · ${fmt(brief.week)} – ${fmt(addDays(brief.week, 4))}`;
    const body = briefText(brief, kind, 'email');
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.length > 1800 ? body.slice(0, 1800) + '\n…' : body)}`;
  }, [brief, kind]);

  const sugg = (k: 'start' | 'stop' | 'continue') => (brief?.suggestions ?? []).filter((s) => s.kind === k).map((s) => s.text);
  const meetingsByDay = brief ? groupBy(brief.meetings, (m) => m.date) : [];

  return (
    <div className="brief">
      <div className="brief__top">
        <h1 className="heading-serif brief__title">Briefs</h1>
        <div className="brief__week">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => go({ week: addDays(week, -7) })} aria-label="Previous week">
            ‹
          </button>
          <span className="brief__week-label">
            {fmt(week)} – {fmt(addDays(week, 6))}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => go({ week: addDays(week, 7) })} aria-label="Next week">
            ›
          </button>
          {week !== mondayOf(today) && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => go({ week: mondayOf(today) })}>
              This Week
            </button>
          )}
        </div>
      </div>

      <div className="brief__bar">
        <SectionPicker options={KINDS} value={kind} onChange={(k) => go({ kind: k })} label="Brief" />
        <div className="brief__copy">
          <button type="button" className="btn btn--sm" onClick={() => copy('slack')} disabled={!brief}>
            {copied === 'slack' ? 'Copied ✓' : 'Copy for Slack'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('email')} disabled={!brief}>
            {copied === 'email' ? 'Copied ✓' : 'Copy for Email'}
          </button>
          <a className="btn btn--ghost btn--sm" href={mailto}>
            ✉️ Email
          </a>
        </div>
      </div>
      {realm !== 'work' && (
        <div className={`brief__realm-note brief__realm-note--${realm}`}>
          {realm === 'all' ? 'Showing Work and Personal together — switch the top bar to 💼 Work before sharing with your team.' : 'Showing Personal only.'}
        </div>
      )}

      {error && <div className="mtg-error">{error}</div>}
      {!brief && !error && <div className="empty-state">Building your brief…</div>}

      {brief && kind === 'ahead' && (
        <div className="brief__grid">
          <Card title="Top Priorities" info="Your own top 3 for the week — typed by you, saved as you go, and first in the copied brief.">
            <ReviewBox label="" value={brief.review.priorities} placeholder={'- Ship the Q4 growth brief\n- 1:1s with every direct report\n- …'} onSave={(v) => saveReview({ priorities: v })} />
          </Card>
          <Card title="Due This Week" count={brief.dueThisWeek.length}>
            {brief.dueThisWeek.length === 0 ? (
              <div className="brief__empty">Nothing due this week.</div>
            ) : (
              groupBy(brief.dueThisWeek, (t) => t.due_date!).map(([d, ts]) => (
                <div key={d} className="brief__day">
                  <div className="brief__day-label">{weekday(d)}</div>
                  <TaskList items={ts} empty="" />
                </div>
              ))
            )}
          </Card>
          <Card title="Carried Over" count={brief.overdue.length} tone={brief.overdue.length ? 'warn' : undefined} info="Open tasks due before this week.">
            <TaskList items={brief.overdue} empty="Nothing overdue." render={(t) => `${t.title} · was due ${fmt(t.due_date!)}`} />
          </Card>
          <Card title="Meetings" count={brief.meetings.length} info={`${brief.meetingHours} hours of meetings this week. Tap one for prep.`}>
            {meetingsByDay.length === 0 ? (
              <div className="brief__empty">No meetings.</div>
            ) : (
              meetingsByDay.map(([d, ms]) => (
                <div key={d} className="brief__day">
                  <div className="brief__day-label">{weekday(d)}</div>
                  <ul className="brief__list">
                    {ms.map((m) => (
                      <li key={m.id} className="brief__item">
                        <button
                          type="button"
                          className="brief__item-btn"
                          onClick={() => openMeetingSheet({ ...(m as unknown as MeetingItem), calendar: '', gcalUrl: null, attendees: [], location: null, links: [], date: m.date })}
                        >
                          <span className="brief__item-time">{m.allDay ? 'All Day' : fmtTime(m.start)}</span>
                          <span className="brief__item-title">{m.title}</span>
                          {m.people.length > 0 && <span className="brief__item-project">{m.people.map((p) => p.name.split(' ')[0]).join(', ')}</span>}
                          <RealmChip realm={m.realm} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </Card>
          <Card title="Waiting On" count={brief.waiting.length}>
            <TaskList items={brief.waiting} empty="Not waiting on anyone." render={(t) => waitLabel(t)} />
          </Card>
          <Card title="Blocked" count={brief.blocked.length} tone={brief.blocked.length ? 'warn' : undefined} info="Tasks you've marked Blocked (in the task's details).">
            <TaskList items={brief.blocked} empty="Nothing blocked." render={(t) => `${t.title}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`} />
          </Card>
          {brief.pendingActions > 0 && (
            <Card title="Next Steps To Sort" count={brief.pendingActions} info="Next steps from meeting notes you haven't turned into a task or Waiting item yet. Open the meeting to decide.">
              <div className="brief__empty">Open a meeting with notes to turn each into a task, a Waiting item, or dismiss it.</div>
            </Card>
          )}
        </div>
      )}

      {brief && kind === 'review' && (
        <div className="brief__grid">
          <Card title="Accomplished" count={brief.done.length} tone="good">
            {brief.done.length === 0 ? (
              <div className="brief__empty">Nothing checked off yet this week.</div>
            ) : (
              groupBy(brief.done, (t) => t.project?.title ?? 'Other').map(([p, ts]) => (
                <div key={p} className="brief__day">
                  <div className="brief__day-label">{p}</div>
                  <ul className="brief__list">
                    {ts.map((t, i) => (
                      <li key={t.id + i} className="brief__item brief__item--done">
                        {t.title}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
            {brief.received.length > 0 && <div className="brief__sub">Also received {brief.received.length} thing{brief.received.length === 1 ? '' : 's'} you were waiting on.</div>}
          </Card>
          <Card title="Pushed" count={brief.pushed.length + brief.slipped.length} tone={brief.pushed.length + brief.slipped.length ? 'warn' : undefined} info="Moved to a later date this week, or due this week and still open.">
            <TaskList
              items={[...brief.pushed, ...brief.slipped]}
              empty="Nothing pushed."
              render={(t) =>
                t.pushCount ? `${t.title} → ${t.due_date ? fmt(t.due_date) : 'later'}${(t.totalPushes ?? 1) > 1 ? ` · pushed ${t.totalPushes}×` : ''}` : `${t.title} · was due ${fmt(t.due_date!)}`
              }
            />
          </Card>
          <Card title="Blocked" count={brief.blocked.length}>
            <TaskList items={brief.blocked} empty="Nothing blocked." render={(t) => `${t.title}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`} />
          </Card>
          <Card title="Waiting On" count={brief.waiting.length}>
            <TaskList items={brief.waiting} empty="Not waiting on anyone." render={(t) => `${waitLabel(t)}${t.waiting_since ? ` · since ${fmt(t.waiting_since)}` : ''}`} />
          </Card>
          <Card title="Start · Stop · Continue" info="Yours to write — tap a suggestion (built from this week's pushes, waits, blocks and wins) to add it.">
            <ReviewBox label="Highlights" value={brief.review.highlights} placeholder="The wins worth calling out" onSave={(v) => saveReview({ highlights: v })} />
            <ReviewBox label="Start" value={brief.review.start} placeholder="What to start doing" onSave={(v) => saveReview({ start: v })} suggestions={sugg('start')} />
            <ReviewBox label="Stop" value={brief.review.stop} placeholder="What to stop doing" onSave={(v) => saveReview({ stop: v })} suggestions={sugg('stop')} />
            <ReviewBox label="Continue" value={brief.review.continue} placeholder="What's working" onSave={(v) => saveReview({ continue: v })} suggestions={sugg('continue')} />
          </Card>
          <Card title="This Week's Meetings" count={brief.meetings.length} info={`${brief.meetingHours} hours in meetings.`}>
            <div className="brief__sub">
              {brief.meetingHours} hours · {brief.meetings.filter((m) => m.summaryCount > 0).length} with notes
            </div>
          </Card>
          <Card title="Next Week" count={brief.dueNextWeek.length}>
            <TaskList items={brief.dueNextWeek.slice(0, 12)} empty="Nothing due next week yet." render={(t) => `${t.title} · ${fmt(t.due_date!, { weekday: 'short' })}`} />
          </Card>
        </div>
      )}

      <div className="brief__foot">
        <Link to="/settings?cat=meetings">Manage meetings</Link>
      </div>
    </div>
  );
}
