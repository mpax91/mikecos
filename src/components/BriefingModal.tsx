import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { BriefingResponse, BriefingMeeting, SearchResult } from '../api/types';
import { buildMeetingNoteTitle } from '../utils/meetingNotes';
import { MOOD_BY_VALUE, moodEmojiForAverage } from '../utils/mood';

// Fired by anything that wants to open the briefing without importing it
// directly (Today page's quick-link) — same window-event pattern
// SearchPalette's OPEN_SEARCH_EVENT already uses, for the same reason: the
// whole feature stays one self-contained component mounted once at the
// app root.
export const OPEN_BRIEFING_EVENT = 'mikeos:open-briefing';

const MEETING_TZ = 'America/New_York';
function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: MEETING_TZ, hour: 'numeric', minute: '2-digit' });
}

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatHeaderDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysAgoLabel(iso: string, today: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return `${diff} days ago`;
}

function inDaysLabel(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n > 1) return `in ${n} days`;
  if (n === -1) return 'expired yesterday';
  return `expired ${-n} days ago`;
}

function upcomingDateIcon(type: 'birthday' | 'anniversary' | 'card_expiry'): string {
  if (type === 'birthday') return '🎂';
  if (type === 'anniversary') return '💍';
  return '💳';
}

const GROUP_ICON: Record<string, string> = {
  notes: '📝',
  jots: '🗒️',
  lists: '☑️',
  projects: '📁',
  vault: '🗄️',
  wallet: '🎫',
  rewards: '💳',
  payment_cards: '🏦',
  boards: '📌',
  contacts: '👤',
  journal: '📔',
  meeting_notes: '🗓️',
  links: '🔗',
};

/** Builds the Tiptap doc a "Prep for this meeting" note starts filled
 * with — everything found automatically, laid out as plain bullet points
 * rather than prose. No text here is generated; it's a direct rendering
 * of the same data the briefing itself already assembled (see
 * computeBriefing in worker/src/index.ts), so it's honest about being
 * assembled rather than written. */
function buildPrepContent(m: BriefingMeeting): string {
  const content: Record<string, unknown>[] = [];
  const paragraph = (text: string, marks?: Record<string, unknown>[]) => ({
    type: 'paragraph',
    content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
  });
  const bulletList = (items: string[]) => ({
    type: 'bulletList',
    content: items.map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
  });

  if (m.location) content.push(paragraph(`📍 ${m.location}`));

  if (m.contactNotes.length > 0) {
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Attendee context' }] });
    content.push(bulletList(m.contactNotes.map((n) => `${n.contactName}: ${n.text}`)));
  }

  if (m.related.length > 0) {
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Related in MikeOS' }] });
    content.push(bulletList(m.related.map((r) => `${GROUP_ICON[r.group] ?? ''} ${r.title}`.trim())));
  }

  if (m.links.length > 0) {
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'From the invite' }] });
    content.push({
      type: 'bulletList',
      content: m.links.map((url) => ({
        type: 'listItem',
        content: [paragraph(url, [{ type: 'link', attrs: { href: url } }])],
      })),
    });
  }

  if (content.length === 0) content.push(paragraph(''));
  return JSON.stringify({ type: 'doc', content });
}

/** A handful of question shapes Mike would actually type, matched by
 * keyword rather than anything generative — see the Search/Chief-of-Staff
 * design discussion this came out of. Anything unrecognized falls back to
 * the same global search the Cmd/Ctrl+K palette uses. */
function matchIntent(q: string, data: BriefingResponse): string[] | null {
  const s = q.toLowerCase();
  if (/(meeting|calendar|schedule|today)/.test(s) && !/(overdue|birthday|anniversary)/.test(s)) {
    if (data.meetings.length === 0) return ["Nothing on the calendar for this day."];
    return data.meetings.map((m) => `${formatMeetingTime(m.start)} — ${m.title}${m.location ? ` (${m.location})` : ''}`);
  }
  if (/overdue/.test(s)) {
    if (data.insights.overdueCount === 0) return ["Nothing overdue — you're caught up."];
    return [`${data.insights.overdueCount} overdue:`, ...data.insights.overdueTasks.map((t) => `• ${t.title}`)];
  }
  if (/(birthday|anniversary|upcoming date|card expir|expiring card)/.test(s)) {
    if (data.insights.upcomingDates.length === 0) return ['Nothing in the next 7 days.'];
    return data.insights.upcomingDates.map((d) => `${upcomingDateIcon(d.type)} ${d.name} — ${inDaysLabel(d.inDays)}`);
  }
  if (/(stale|quiet|neglected)/.test(s) && /project/.test(s)) {
    if (data.insights.staleProjects.length === 0) return ['Every project has had activity recently.'];
    return data.insights.staleProjects.map((p) => `${p.title} — quiet since ${formatShortDate(p.last_touched)}`);
  }
  if (/(plex|episode|aired|airing)/.test(s)) {
    if (data.insights.missingEpisodes.length === 0) return ['Nothing outstanding — your library is caught up.'];
    return data.insights.missingEpisodes.map(
      (ep) => `🎬 ${ep.show_title} ${String(ep.season_number).padStart(2, '0')}×${String(ep.episode_number).padStart(2, '0')} — aired ${formatShortDate(ep.aired_on)}`
    );
  }
  if (/(this week|last week|retrospective|recap)/.test(s)) {
    const r = data.retrospective;
    const lines = [`${r.tasksCompleted} tasks completed this week (${r.tasksCompletedPrevWeek} the week before)`, `Journaled ${r.journalDays}/7 days`];
    if (r.avgMood != null) lines.push(`Average mood: ${moodEmojiForAverage(r.avgMood)}`);
    return lines;
  }
  return null;
}

export function BriefingModal() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayLocalISO());
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [preppingId, setPreppingId] = useState<string | null>(null);
  const [askQuery, setAskQuery] = useState('');
  const [askAnswer, setAskAnswer] = useState<string[] | null>(null);
  const [askResults, setAskResults] = useState<SearchResult[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback((d: string) => {
    setLoading(true);
    api
      .getBriefing(d)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function onOpenEvent() {
      setDate(todayLocalISO());
      setAskQuery('');
      setAskAnswer(null);
      setAskResults(null);
      setOpen(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener(OPEN_BRIEFING_EVENT, onOpenEvent);
    return () => window.removeEventListener(OPEN_BRIEFING_EVENT, onOpenEvent);
  }, []);

  useEffect(() => {
    if (open) load(date);
  }, [open, date, load]);

  function close() {
    setOpen(false);
  }

  function goTo(path: string, openId?: string | null) {
    close();
    navigate(path, openId ? { state: { openId } } : undefined);
  }

  async function prepMeeting(m: BriefingMeeting) {
    if (m.noteEntityId) {
      goTo(`/notes/${m.noteEntityId}`);
      return;
    }
    setPreppingId(m.id);
    try {
      const { noteEntityId } = await api.createMeetingNote(m.id, buildMeetingNoteTitle(m));
      await api.updateEntity(noteEntityId, { content: buildPrepContent(m) });
      goTo(`/notes/${noteEntityId}`);
    } finally {
      setPreppingId(null);
    }
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = askQuery.trim();
    if (!q || !data) return;
    setAskResults(null);
    const matched = matchIntent(q, data);
    if (matched) {
      setAskAnswer(matched);
      return;
    }
    setAskAnswer(null);
    const res = await api.search(q);
    const flat = res.groups.flatMap((g) => g.results).sort((a, b) => b.score - a.score);
    setAskResults(flat.slice(0, 8));
  }

  const heading = date === todayLocalISO() ? 'Today' : formatShortDate(date);
  const meetingCountLabel = useMemo(() => {
    if (!data) return '';
    const n = data.meetings.length;
    return n === 0 ? 'Nothing on the calendar' : `${n} meeting${n === 1 ? '' : 's'}`;
  }, [data]);

  if (!open) return null;

  return (
    <div className="briefing-modal-backdrop" onClick={close}>
      <div className="briefing-modal" onClick={(e) => e.stopPropagation()}>
        <div className="briefing-modal__header">
          <div>
            <div className="briefing-modal__eyebrow">🧭 Daily Briefing</div>
            <h2 className="briefing-modal__heading">{heading}</h2>
            <div className="briefing-modal__date-line">
              {formatHeaderDate(date)} · {loading ? 'Loading…' : meetingCountLabel}
            </div>
          </div>
          <button type="button" className="briefing-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="briefing-modal__body">
          {loading && !data && <div className="briefing-modal__hint">Pulling today together…</div>}

          {data && data.meetings.length > 0 && (
            <div className="briefing-modal__section">
              <div className="briefing-modal__section-label">Meetings</div>
              {data.meetings.map((m) => (
                <div className="briefing-modal__meeting" key={m.id}>
                  <div className="briefing-modal__meeting-head">
                    <span className="briefing-modal__meeting-time">{m.allDay ? 'All day' : formatMeetingTime(m.start)}</span>
                    <span className="briefing-modal__meeting-title">{m.title}</span>
                  </div>
                  {m.location && <div className="briefing-modal__meeting-line">📍 {m.location}</div>}

                  {m.attendees.length > 0 && (
                    <div className="briefing-modal__chips">
                      {m.attendees.map((a) => (
                        <span key={a.email} className={`briefing-modal__chip${a.contactId ? ' briefing-modal__chip--matched' : ''}`}>
                          {a.contactId ? '👤 ' : ''}
                          {a.contactName ?? a.name ?? a.email}
                        </span>
                      ))}
                    </div>
                  )}

                  {m.contactNotes.length > 0 && (
                    <ul className="briefing-modal__list">
                      {m.contactNotes.map((n, i) => (
                        <li key={i}>
                          <strong>{n.contactName}:</strong> {n.text}
                        </li>
                      ))}
                    </ul>
                  )}

                  {m.related.length > 0 && (
                    <div className="briefing-modal__related">
                      {m.related.map((r) => (
                        <button key={`${r.group}:${r.id}`} type="button" className="briefing-modal__related-item" onClick={() => goTo(r.path, r.openId)}>
                          {GROUP_ICON[r.group] ?? ''} {r.title}
                        </button>
                      ))}
                    </div>
                  )}

                  {m.links.length > 0 && (
                    <div className="briefing-modal__meeting-line">
                      🔗{' '}
                      {m.links.map((url, i) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          {i > 0 && ' · '}
                          {url.replace(/^https?:\/\//, '').slice(0, 40)}
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="briefing-modal__meeting-actions">
                    <button type="button" className="btn btn--ghost" disabled={preppingId === m.id} onClick={() => prepMeeting(m)}>
                      {m.noteEntityId ? '📝 Open prep note' : preppingId === m.id ? 'Preparing…' : '📝 Prep for this meeting'}
                    </button>
                    {m.gcalUrl && (
                      <a className="btn btn--ghost" href={m.gcalUrl} target="_blank" rel="noreferrer">
                        📅 Open in Calendar
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data &&
            (data.insights.overdueCount > 0 ||
              data.insights.upcomingDates.length > 0 ||
              data.insights.staleProjects.length > 0 ||
              data.insights.missingEpisodes.length > 0) && (
            <div className="briefing-modal__section">
              <div className="briefing-modal__section-label">Worth a glance</div>
              <ul className="briefing-modal__list briefing-modal__list--insights">
                {data.insights.overdueCount > 0 && (
                  <li>
                    ⚠️ {data.insights.overdueCount} overdue task{data.insights.overdueCount === 1 ? '' : 's'}
                    {data.insights.overdueTasks.length > 0 && (
                      <span className="briefing-modal__hint"> — {data.insights.overdueTasks.map((t) => t.title).join(', ')}</span>
                    )}
                  </li>
                )}
                {data.insights.upcomingDates.map((d) => (
                  <li key={`${d.type}-${d.contactId ?? d.cardId}`}>
                    <button
                      type="button"
                      className="briefing-modal__link-btn"
                      onClick={() => (d.type === 'card_expiry' ? goTo('/wallet?tab=payment', d.cardId) : goTo(`/contacts/${d.contactId}`))}
                    >
                      {upcomingDateIcon(d.type)} {d.name} — {inDaysLabel(d.inDays)}
                    </button>
                  </li>
                ))}
                {data.insights.staleProjects.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="briefing-modal__link-btn" onClick={() => goTo(`/projects/${p.id}`)}>
                      🕸️ {p.title} — quiet since {daysAgoLabel(p.last_touched.slice(0, 10), date)}
                    </button>
                  </li>
                ))}
                {data.insights.missingEpisodes.map((ep) => (
                  <li key={ep.id}>
                    <button type="button" className="briefing-modal__link-btn" onClick={() => goTo('/plex?tab=airing')}>
                      🎬 {ep.show_title} {String(ep.season_number).padStart(2, '0')}×{String(ep.episode_number).padStart(2, '0')} — aired{' '}
                      {daysAgoLabel(ep.aired_on, date)}, not in your library
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data && (
            <div className="briefing-modal__section">
              <div className="briefing-modal__section-label">This week</div>
              <div className="briefing-modal__retro">
                <span>
                  ✅ {data.retrospective.tasksCompleted} completed
                  <span className="briefing-modal__hint"> ({data.retrospective.tasksCompletedPrevWeek} last week)</span>
                </span>
                <span>📔 Journaled {data.retrospective.journalDays}/7 days</span>
                {data.retrospective.avgMood != null && (
                  <span>
                    {moodEmojiForAverage(data.retrospective.avgMood)} Avg mood
                    <span className="briefing-modal__hint"> ({MOOD_BY_VALUE.get(Math.round(data.retrospective.avgMood))?.label ?? '—'})</span>
                  </span>
                )}
                {data.retrospective.topProjects.length > 0 && (
                  <span>🏆 Most active: {data.retrospective.topProjects[0].title}</span>
                )}
              </div>
            </div>
          )}

          <div className="briefing-modal__section briefing-modal__ask">
            <div className="briefing-modal__section-label">Ask</div>
            <form onSubmit={ask} className="briefing-modal__ask-form">
              <input
                ref={inputRef}
                className="briefing-modal__ask-input"
                placeholder="What's overdue? Any birthdays coming up? …"
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
              />
              <button type="submit" className="btn">
                Ask
              </button>
            </form>
            {askAnswer && (
              <ul className="briefing-modal__list">
                {askAnswer.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {askResults && (
              <ul className="briefing-modal__list">
                {askResults.length === 0 && <li>No results.</li>}
                {askResults.map((r) => (
                  <li key={`${r.group}:${r.id}`}>
                    <button type="button" className="briefing-modal__link-btn" onClick={() => goTo(r.path, r.openId)}>
                      {GROUP_ICON[r.group] ?? ''} {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
