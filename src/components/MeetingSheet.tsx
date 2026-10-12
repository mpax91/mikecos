import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { MeetingAction, MeetingItem, MeetingPrep, MeetingSummary, WorkTask } from '../api/types';
import { DetailSheet } from './dash/DetailSheet';
import { RealmChip } from './RealmSwitch';
import { buildMeetingNoteTitle } from '../utils/meetingNotes';
import { MeetingDocs, seriesKeyFor } from './MeetingDocs';

/** One meeting, everything about it: morning-of prep (people, what's open
 * with them, last time's notes, open next steps), this meeting's own notes,
 * and pasting in the Gemini summary afterwards (next steps → a task for Mike
 * or a Waiting item on someone else). Opened from any meeting row via
 * openMeetingSheet(). */

export const OPEN_MEETING_EVENT = 'mikeos:open-meeting';
export const MEETING_CHANGED_EVENT = 'mikeos:meeting-changed';

type SheetMeeting = MeetingItem & { date?: string };

export function openMeetingSheet(meeting: SheetMeeting, opts?: { paste?: boolean }) {
  window.dispatchEvent(new CustomEvent(OPEN_MEETING_EVENT, { detail: { meeting, paste: !!opts?.paste } }));
}

const TZ = 'America/New_York';
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const localDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
function fmtDue(d: string | null) {
  if (!d) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function ago(iso: string | null): string {
  if (!iso) return '';
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function MeetingSheetHost() {
  const [state, setState] = useState<{ meeting: SheetMeeting; paste: boolean } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<{ meeting: SheetMeeting; paste: boolean }>).detail);
    window.addEventListener(OPEN_MEETING_EVENT, on);
    return () => window.removeEventListener(OPEN_MEETING_EVENT, on);
  }, []);
  const close = useCallback(() => setState(null), []);
  if (!state) return null;
  return <MeetingSheet key={state.meeting.id} meeting={state.meeting} startPasting={state.paste} onClose={close} />;
}

function TaskLine({ t, onOpen, person }: { t: WorkTask; onOpen: (t: WorkTask) => void; person?: string }) {
  let title = t.title.replace(/^Check Back: /, '');
  if (person && title.endsWith(` (${person})`)) title = title.slice(0, -(person.length + 3));
  return (
    <li className="mtg-task">
      <button type="button" className="mtg-task__btn" onClick={() => onOpen(t)}>
        <span className="mtg-task__title">{title}</span>
        {t.blocked_reason != null && <span className="mtg-pill mtg-pill--blocked">Blocked</span>}
        {t.due_date && <span className="mtg-task__due">{fmtDue(t.due_date)}</span>}
      </button>
    </li>
  );
}

function ActionRow({ a, onChange }: { a: MeetingAction; onChange: (a: MeetingAction) => void }) {
  const [busy, setBusy] = useState(false);
  const who = a.isMine ? 'Me' : a.contactName ?? a.ownerName;
  async function decide(decision: MeetingAction['status']) {
    setBusy(true);
    try {
      onChange(await api.decideMeetingAction(a.id, { decision }));
      window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
    } finally {
      setBusy(false);
    }
  }
  const decided = a.status !== 'pending';
  return (
    <li className={`mtg-action mtg-action--${a.status}`}>
      <div className="mtg-action__text">
        {who && <span className={`mtg-owner${a.isMine ? ' mtg-owner--me' : ''}`}>{who}</span>}
        <span>{a.text}</span>
      </div>
      <div className="mtg-action__btns">
        {!decided ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide('task')}>
              ✓ My Task
            </button>
            {!a.isMine && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide('waiting')}>
                ⏳ Waiting On {who?.split(' ')[0] ?? 'Them'}
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--sm mtg-quiet" disabled={busy} onClick={() => decide('dismissed')}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <span className={`mtg-pill mtg-pill--${a.status}`}>
              {a.status === 'task' ? (a.entityDone ? 'Task · Done' : 'My Task') : a.status === 'waiting' ? (a.entityDone ? 'Received' : 'Waiting') : 'Dismissed'}
            </span>
            <button type="button" className="btn btn--ghost btn--sm mtg-quiet" disabled={busy} onClick={() => decide('pending')}>
              Undo
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function SummaryBlock({ s, compact = false }: { s: MeetingSummary; compact?: boolean }) {
  return (
    <div className={`mtg-summary${compact ? ' mtg-summary--compact' : ''}`}>
      {s.summary && <p className="mtg-summary__text">{s.summary}</p>}
      {s.decisions && (
        <div className="mtg-summary__decisions">
          <div className="mtg-label">Decisions</div>
          <pre>{s.decisions}</pre>
        </div>
      )}
      {s.noteEntityId && (
        <Link className="mtg-link" to={`/notes/${s.noteEntityId}`}>
          Full notes →
        </Link>
      )}
    </div>
  );
}

function MeetingSheet({ meeting, startPasting, onClose }: { meeting: SheetMeeting; startPasting: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const date = meeting.date ?? localDate(meeting.start);
  const [prep, setPrep] = useState<MeetingPrep | null>(null);
  const [own, setOwn] = useState<{ summaries: MeetingSummary[]; actions: MeetingAction[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(startPasting);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ended = !meeting.allDay && Date.parse(meeting.end) <= Date.now();

  const load = useCallback(() => {
    api.getMeetingPrep(date, meeting.id).then(setPrep).catch((e) => setError(String(e.message ?? e)));
    api.getMeetingSummaries(meeting.id).then(setOwn).catch(() => setOwn({ summaries: [], actions: [] }));
  }, [date, meeting.id]);
  useEffect(load, [load]);

  const m = prep?.meeting ?? meeting;
  const people = prep?.people ?? [];

  async function openAgenda() {
    const existing = prep?.agendaNoteId ?? (meeting.hasNote ? (await api.getMeetingNote(meeting.id)).noteEntityId : null);
    if (existing) {
      onClose();
      navigate(`/notes/${existing}`);
      return;
    }
    const { noteEntityId } = await api.createMeetingNote(meeting.id, buildMeetingNoteTitle(meeting), m.realm);
    onClose();
    window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
    navigate(`/notes/${noteEntityId}`);
  }

  async function saveSummary() {
    if (text.trim().length < 10) return;
    setSaving(true);
    setError(null);
    try {
      await api.addMeetingSummary(meeting.id, {
        text,
        title: meeting.title,
        start: meeting.start,
        realm: m.realm,
        peopleIds: (m.people ?? []).map((p) => p.id),
      });
      setText('');
      setPasting(false);
      window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+: /, '') : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return setError('That file is too big — paste the text instead.');
    if (!/\.(txt|md|markdown|text)$/i.test(f.name) && f.type && !f.type.startsWith('text/')) {
      return setError('Upload a .txt or .md file (in Google Docs: File → Download → Plain text), or paste the text.');
    }
    setText(await f.text());
    setPasting(true);
  }

  async function skipThisOne() {
    if (!m.seriesId) return;
    if (!window.confirm(`Cancel "${meeting.title}" on ${fmtDay(meeting.start)}? The rest of the series stays.`)) return;
    await api.skipMeetingOccurrence(m.seriesId, date, true);
    window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
    onClose();
  }

  async function removeSummary(id: string) {
    if (!window.confirm('Remove these notes? Tasks and Waiting items already made stay.')) return;
    await api.deleteMeetingSummary(id);
    load();
  }

  function openTask(t: WorkTask) {
    onClose();
    if (t.waiting_source_id || t.waiting_since) navigate('/waiting');
    else if (t.project) navigate(`/projects/${t.project.id}`, { state: { openId: t.id } });
    else navigate(`/today/${t.due_date ?? ''}`.replace(/\/$/, ''));
  }

  const updateAction = (list: MeetingAction[], a: MeetingAction) => list.map((x) => (x.id === a.id ? a : x));
  const link = m.joinUrl ?? m.links?.find((l) => /meet\.google|zoom\.us|teams\.microsoft|webex/i.test(l)) ?? m.links?.[0];

  const sub = (
    <span className="mtg-sub">
      {fmtDay(meeting.start)} · {meeting.allDay ? 'All Day' : `${fmtTime(meeting.start)} – ${fmtTime(meeting.end)}`}
      {m.recurring && ' · Repeats'}
      {m.location && ` · ${m.location}`} <RealmChip realm={m.realm} always />
    </span>
  );

  return (
    <DetailSheet title={meeting.title} sub={sub} onClose={onClose}>
      <div className="mtg">
        <div className="mtg__toolbar">
          <button type="button" className="btn btn--ghost btn--sm" onClick={openAgenda} disabled={!prep?.agendaNoteId && !meeting.hasNote && ended}>
            📝 {prep?.agendaNoteId || meeting.hasNote ? 'My Notes' : 'Agenda / Notes'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPasting((v) => !v)}>
            ✨ Add Meeting Notes
          </button>
          {link && (
            <a className="btn btn--ghost btn--sm" href={link} target="_blank" rel="noreferrer">
              🎥 Join
            </a>
          )}
          {meeting.gcalUrl && (
            <a className="btn btn--ghost btn--sm mtg-quiet" href={meeting.gcalUrl} target="_blank" rel="noreferrer">
              📅 Google Calendar
            </a>
          )}
          {m.seriesId && (
            <>
              <button type="button" className="btn btn--ghost btn--sm mtg-quiet" onClick={() => (onClose(), navigate(`/settings?cat=meetings&series=${m.seriesId}`))}>
                ⚙️ Edit Meeting
              </button>
              {!ended && m.recurring && (
                <button type="button" className="btn btn--ghost btn--sm mtg-quiet" onClick={skipThisOne}>
                  Skip This One
                </button>
              )}
            </>
          )}
        </div>

        {error && <div className="mtg-error">{error}</div>}

        <MeetingDocs
          seriesKey={meeting.seriesKey ?? seriesKeyFor(meeting.id)}
          recurring={!!m.recurring}
          inviteLinks={m.links ?? []}
          onChanged={() => window.dispatchEvent(new Event(MEETING_CHANGED_EVENT))}
        />

        {pasting && (
          <section className="mtg-section mtg-paste">
            <div className="mtg-section__title">Add Meeting Notes</div>
            <p className="mtg-hint">Paste "Notes by Gemini" (or any notes). Summary, decisions and next steps are pulled out; you decide what each next step becomes.</p>
            <textarea className="mtg-paste__box" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Summary\n…\n\nSuggested next steps\n* Mike Palladino will …\n* Sarah Chen will …'} autoFocus />
            <div className="mtg-paste__row">
              <button type="button" className="btn" disabled={saving || text.trim().length < 10} onClick={saveSummary}>
                {saving ? 'Reading…' : 'Save Notes'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => fileRef.current?.click()}>
                Upload .txt
              </button>
              <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              <button type="button" className="btn btn--ghost" onClick={() => setPasting(false)}>
                Cancel
              </button>
            </div>
          </section>
        )}

        {/* This occurrence's own notes + next steps. */}
        {own && own.summaries.length > 0 && (
          <section className="mtg-section">
            <div className="mtg-section__title">From This Meeting</div>
            {own.summaries.map((s) => (
              <div key={s.id} className="mtg-own">
                <SummaryBlock s={s} />
                <ul className="mtg-actions">
                  {own.actions
                    .filter((a) => a.summaryId === s.id)
                    .map((a) => (
                      <ActionRow key={a.id} a={a} onChange={(na) => setOwn((o) => (o ? { ...o, actions: updateAction(o.actions, na) } : o))} />
                    ))}
                </ul>
                <button type="button" className="mtg-link mtg-link--quiet" onClick={() => removeSummary(s.id)}>
                  Remove these notes
                </button>
              </div>
            ))}
          </section>
        )}

        {!prep && !error && <div className="mtg-hint">Loading prep…</div>}

        {prep && (
          <>
            {people.length > 0 && (
              <section className="mtg-section">
                <div className="mtg-section__title">People</div>
                <div className="mtg-people">
                  {people.map((p) => (
                    <div key={p.id} className="mtg-person">
                      <div className="mtg-person__head">
                        <Link to={`/contacts/${p.id}`} className="mtg-person__name" onClick={onClose}>
                          {p.name}
                        </Link>
                        {(p.title || p.company) && <span className="mtg-person__role">{[p.title, p.company].filter(Boolean).join(' · ')}</span>}
                        {p.lastMet && <span className="mtg-person__last">Last met {ago(p.lastMet)}</span>}
                      </div>
                      {p.iOwe.length > 0 && (
                        <div className="mtg-person__block">
                          <div className="mtg-label">You Owe</div>
                          <ul className="mtg-tasks">{p.iOwe.map((t) => <TaskLine key={t.id} t={t} onOpen={openTask} />)}</ul>
                        </div>
                      )}
                      {p.theyOwe.length > 0 && (
                        <div className="mtg-person__block">
                          <div className="mtg-label">Waiting On {p.name.split(' ')[0]}</div>
                          <ul className="mtg-tasks">{p.theyOwe.map((t) => <TaskLine key={t.id} t={t} onOpen={openTask} person={p.name} />)}</ul>
                        </div>
                      )}
                      {p.recentNotes.length > 0 && (
                        <div className="mtg-person__block">
                          <div className="mtg-label">Notes</div>
                          {p.recentNotes.map((n, i) => (
                            <p key={i} className="mtg-person__note">
                              {n.text.length > 220 ? n.text.slice(0, 220) + '…' : n.text}
                            </p>
                          ))}
                        </div>
                      )}
                      {p.iOwe.length === 0 && p.theyOwe.length === 0 && p.recentNotes.length === 0 && <div className="mtg-hint">Nothing open with {p.name.split(' ')[0]}.</div>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {prep.openActions.filter((a) => a.meetingId !== meeting.id).length > 0 && (
              <section className="mtg-section">
                <div className="mtg-section__title">Still Open From Earlier Meetings</div>
                <ul className="mtg-actions">
                  {prep.openActions
                    .filter((a) => a.meetingId !== meeting.id)
                    .map((a) => (
                      <ActionRow key={a.id} a={a} onChange={(na) => setPrep((p) => (p ? { ...p, openActions: updateAction(p.openActions, na) } : p))} />
                    ))}
                </ul>
              </section>
            )}

            {prep.past.length > 0 && (
              <section className="mtg-section">
                <div className="mtg-section__title">Last Time{prep.past.length > 1 ? 's' : ''}</div>
                {prep.past.map((h) => (
                  <div key={h.meetingId} className="mtg-past">
                    <div className="mtg-past__date">{fmtDay(h.start)}</div>
                    {h.summary && <SummaryBlock s={h.summary} compact />}
                    {h.myNote && (
                      <Link className="mtg-past__note" to={`/notes/${h.myNote.id}`} onClick={onClose}>
                        <span className="mtg-label">My Notes</span> {h.myNote.snippet ? h.myNote.snippet.slice(0, 240) + (h.myNote.snippet.length > 240 ? '…' : '') : h.myNote.title}
                      </Link>
                    )}
                  </div>
                ))}
              </section>
            )}

            {prep.project && (
              <section className="mtg-section">
                <div className="mtg-section__title">
                  <Link to={`/projects/${prep.project.id}`} onClick={onClose}>
                    {prep.project.title}
                  </Link>{' '}
                  · Open Tasks
                </div>
                {prep.project.openTasks.length ? (
                  <ul className="mtg-tasks">{prep.project.openTasks.map((t) => <TaskLine key={t.id} t={t} onOpen={() => (onClose(), navigate(`/projects/${prep.project!.id}`, { state: { openId: t.id } }))} />)}</ul>
                ) : (
                  <div className="mtg-hint">No open tasks.</div>
                )}
              </section>
            )}

            {people.length === 0 && prep.past.length === 0 && !prep.project && (!own || own.summaries.length === 0) && (
              <div className="mtg-hint">
                No history yet.{' '}
                {m.seriesId ? 'Add people to this meeting in Settings → Meetings to see what you have open with them.' : 'Notes you add after the meeting show up here next time.'}
              </div>
            )}
          </>
        )}
      </div>
    </DetailSheet>
  );
}
