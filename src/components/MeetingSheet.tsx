import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { BriefPersonSuggestion, MeetingAction, MeetingAssist, MeetingItem, MeetingPrep, MeetingRecordItem, MeetingSummary, MeetingSummaryBundle, WorkTask } from '../api/types';
import { DetailSheet } from './dash/DetailSheet';
import { InfoTip } from './dash/InfoTip';
import { RealmChip } from './RealmSwitch';
import { meetingPeopleNames, buildMeetingNoteTitle } from '../utils/meetingNotes';
import { MeetingDocs, seriesKeyFor } from './MeetingDocs';
import { copyText } from '../utils/clipboard';
import { meetingPacket } from '../utils/claudePacket';

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

function CopyButton({ text, label = 'Copy', className = 'btn btn--ghost btn--sm' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1800);
        }
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

function ActionRow({ a, onChange, assist }: { a: MeetingAction; onChange: (a: MeetingAction) => void; assist?: MeetingAssist }) {
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
        {who ? <span className={`mtg-owner${a.isMine ? ' mtg-owner--me' : ''}`}>{who}</span> : <span className="mtg-owner mtg-owner--none">Unowned</span>}
        <span>{a.text}</span>
        {a.isMine && a.contactName && <span className="mtg-with">with {a.contactName.split(' ')[0]}</span>}
        {a.dueDate && a.status === 'pending' && <span className="mtg-with">due {fmtDue(a.dueDate)}</span>}
        {a.confidence === 'implied' && (
          <span className="mtg-pill mtg-pill--implied" title="Claude inferred the owner — check it before sorting">
            implied
          </span>
        )}
      </div>
      <div className="mtg-action__btns">
        {assist && <CopyButton text={assist.prompt} label="✨ Copy AI Prompt" className="btn btn--ghost btn--sm mtg-ai" />}
        {!decided ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide('task')}>
              ✓ My Task
            </button>
            {!a.isMine && who && (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => decide('waiting')}>
                ⏳ Waiting On {who.split(' ')[0]}
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
      {s.tldr && s.tldr.length > 0 ? (
        <ul className="mtg-tldr">
          {s.tldr.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        s.summary && <p className="mtg-summary__text">{s.summary}</p>
      )}
      {s.decisions && (
        <div className="mtg-summary__decisions">
          <div className="mtg-label">Decisions</div>
          <pre>{s.decisions}</pre>
        </div>
      )}
      {s.noteEntityId && !(s.source === 'record' && !compact) && (
        <Link className="mtg-link" to={`/notes/${s.noteEntityId}`}>
          {s.source === 'record' ? 'Full brief →' : 'Full notes →'}
        </Link>
      )}
    </div>
  );
}

const FT_LABEL: Record<string, string> = { done: 'Done', in_progress: 'In Progress', open: 'Not Done', unclear: 'No Update' };

const ITEM_TITLES: Record<string, string> = {
  goal: 'What to Get Out of It',
  talking_point: 'Talking Points',
  prep_question: 'Questions to Ask',
  watch_out: 'Watch-Outs',
  question: 'Open Questions',
};

/** Open questions / watch-outs (check off once handled) or prep lists. */
function ItemList({ items, kind, checkable, onChange }: { items: MeetingRecordItem[]; kind: string; checkable?: boolean; onChange?: (i: MeetingRecordItem) => void }) {
  const list = items.filter((i) => i.kind === kind);
  if (!list.length) return null;
  return (
    <div className="mtg-items">
      <div className="mtg-label">{ITEM_TITLES[kind] ?? kind}</div>
      <ul className="mtg-items__list">
        {list.map((i) => (
          <li key={i.id} className={`mtg-item${i.resolvedAt ? ' is-done' : ''}`}>
            {checkable ? (
              <label className="mtg-item__check">
                <input type="checkbox" checked={!!i.resolvedAt} onChange={async (e) => onChange?.(await api.resolveMeetingItem(i.id, e.target.checked))} />
                <span>{i.text}</span>
              </label>
            ) : (
              <span>{i.text}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a pasted brief adds beyond the next steps: who was inferred,
 * materials, open questions / watch-outs, AI prompts, people to add. */
function BriefExtras({
  s,
  items,
  assists,
  suggestions,
  onChanged,
}: {
  s: MeetingSummary;
  items: MeetingRecordItem[];
  assists: MeetingAssist[];
  suggestions: BriefPersonSuggestion[];
  onChanged: () => void;
}) {
  const mine = items.filter((i) => i.summaryId === s.id);
  const prompts = assists.filter((a) => a.summaryId === s.id);
  const people = suggestions.filter((p) => p.summaryId === s.id);
  const materials = mine.filter((i) => i.kind === 'material');
  const [busy, setBusy] = useState<string | null>(null);
  async function person(p: BriefPersonSuggestion, ignore: boolean) {
    setBusy(p.name);
    try {
      await api.addBriefPerson(s.id, { name: p.name, email: p.email, ignore });
      window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
      onChanged();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="mtg-brief">
      {s.attendeesConfirmed === false && (
        <div className="mtg-chip-row">
          <span className="mtg-pill mtg-pill--implied" title="Claude guessed who was there from the notes">
            Attendees inferred — confirm
          </span>
          {(s.attendees ?? []).length > 0 && <span className="mtg-hint">{(s.attendees ?? []).map((a) => a.name).join(', ')}</span>}
        </div>
      )}
      {materials.length > 0 && (
        <div className="mtg-items">
          <div className="mtg-label">Materials</div>
          <ul className="mtg-items__list">
            {materials.map((m) => (
              <li key={m.id} className="mtg-item">
                <span className="mtg-item__material">{m.materialType ?? 'file'}</span> <strong>{m.text}</strong>
                {m.takeaway && <span className="mtg-item__takeaway"> — {m.takeaway}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {mine.some((i) => i.kind === 'follow_through') && (
        <div className="mtg-items">
          <div className="mtg-label">Follow-Through From Last Time</div>
          <ul className="mtg-items__list">
            {mine
              .filter((i) => i.kind === 'follow_through')
              .map((i) => (
                <li key={i.id} className="mtg-item">
                  <span className={`mtg-ft mtg-ft--${i.status ?? 'unclear'}`}>{FT_LABEL[i.status ?? 'unclear'] ?? 'Unclear'}</span> {i.owner && <strong>{i.owner}: </strong>}
                  {i.text}
                  {i.note && <span className="mtg-item__takeaway"> — {i.note}</span>}
                </li>
              ))}
          </ul>
        </div>
      )}
      {prompts.length > 0 && (
        <div className="mtg-items">
          <div className="mtg-label">
            Where AI Can Help{' '}
            <InfoTip label="About these prompts">Each prompt carries its own context. Copy it into a new chat in your work Claude Project.</InfoTip>
          </div>
          <ul className="mtg-assists">
            {prompts.map((a) => (
              <li key={a.id} className="mtg-assist">
                <details>
                  <summary>{a.title}</summary>
                  <p className="mtg-assist__prompt">{a.prompt}</p>
                </details>
                <CopyButton text={a.prompt} label="Copy" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {people.length > 0 && (
        <div className="mtg-items">
          <div className="mtg-label">Not in Contacts Yet</div>
          <ul className="mtg-items__list">
            {people.map((p) => (
              <li key={p.name} className="mtg-suggest">
                <span>
                  {p.name}
                  {p.email && <span className="mtg-hint"> · {p.email}</span>}
                </span>
                <span className="mtg-suggest__btns">
                  <button type="button" className="btn btn--sm" disabled={busy === p.name} onClick={() => person(p, false)}>
                    + Add Contact
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm mtg-quiet" disabled={busy === p.name} onClick={() => person(p, true)} aria-label={`Don't add ${p.name}`}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MeetingSheet({ meeting, startPasting, onClose }: { meeting: SheetMeeting; startPasting: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const date = meeting.date ?? localDate(meeting.start);
  const [prep, setPrep] = useState<MeetingPrep | null>(null);
  const [own, setOwn] = useState<MeetingSummaryBundle | null>(null);
  // Threads and briefs with no calendar match have no meeting behind them.
  const isThread = meeting.id.startsWith('thread-') || meeting.id.startsWith('brief-');
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(startPasting);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ended = !meeting.allDay && Date.parse(meeting.end) <= Date.now();

  // Prep first: loading it re-reads this meeting's 📝 note for next steps,
  // so the items list fetched after it is current.
  const load = useCallback(() => {
    if (isThread) {
      api
        .getMeetingSummaries(meeting.id)
        .then(setOwn)
        .catch(() => setOwn({ summaries: [], actions: [] }));
      return;
    }
    api
      .getMeetingPrep(date, meeting.id)
      .then(setPrep)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => api.getMeetingSummaries(meeting.id).then(setOwn).catch(() => setOwn({ summaries: [], actions: [] })));
  }, [date, meeting.id, isThread]);
  const [accepting, setAccepting] = useState(false);
  const myPending = own?.actions.filter((a) => a.status === 'pending' && a.isMine).length ?? 0;
  const theirPending = own?.actions.filter((a) => a.status === 'pending' && !a.isMine).length ?? 0;
  async function acceptMine() {
    setAccepting(true);
    try {
      const r = await api.acceptMyMeetingActions(meeting.id);
      setOwn((o) => (o ? { ...o, actions: r.actions } : o));
      window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
    } finally {
      setAccepting(false);
    }
  }
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
    const { noteEntityId } = await api.createMeetingNote(meeting.id, buildMeetingNoteTitle(meeting), m.realm, meetingPeopleNames(m));
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
        date,
        allDay: meeting.allDay,
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
    window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
    if (isThread) onClose();
    else load();
  }

  function openTask(t: WorkTask) {
    onClose();
    if (t.waiting_source_id || t.waiting_since) navigate('/waiting');
    else if (t.project) navigate(`/projects/${t.project.id}`, { state: { openId: t.id } });
    else navigate(`/today/${t.due_date ?? ''}`.replace(/\/$/, ''));
  }

  const updateAction = (list: MeetingAction[], a: MeetingAction) => list.map((x) => (x.id === a.id ? a : x));
  const assistFor = (a: MeetingAction) => (a.hasPrompt ? (own?.assists ?? []).find((x) => x.actionId === a.id) : undefined);
  const link = m.joinUrl ?? m.links?.find((l) => /meet\.google|zoom\.us|teams\.microsoft|webex/i.test(l)) ?? m.links?.[0];

  const sub = isThread ? (
    <span className="mtg-sub">
      {meeting.thread?.label ?? 'Thread'}
      {meeting.thread?.channel && ` · ${meeting.thread.channel}`} · {fmtDay(meeting.start)} <RealmChip realm="work" always />
    </span>
  ) : (
    <span className="mtg-sub">
      {fmtDay(meeting.start)} · {meeting.allDay ? 'All Day' : `${fmtTime(meeting.start)} – ${fmtTime(meeting.end)}`}
      {m.recurring && ' · Repeats'}
      {m.location && ` · ${m.location}`} <RealmChip realm={m.realm} always />
    </span>
  );

  return (
    <DetailSheet title={meeting.title} sub={sub} onClose={onClose}>
      <div className="mtg">
        {!isThread && (
        <div className="mtg__toolbar">
          <button type="button" className="btn btn--ghost btn--sm" onClick={openAgenda} disabled={!prep?.agendaNoteId && !meeting.hasNote && ended}>
            📝 {prep?.agendaNoteId || meeting.hasNote ? 'My Notes' : 'Agenda / Notes'}
          </button>
          <InfoTip label="How meeting notes work">
            Notes are for reading, not sorting. Paste your work Claude's brief with 📋 Paste Brief (or Add Meeting Notes here); the next day a Review task opens it. In any note, highlight text to make it a Task, Waiting item,
            Project, List item, Jot, Link — or 👤 something to raise with a person next time.
          </InfoTip>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPasting((v) => !v)}>
            ✨ Add Meeting Notes
          </button>
          <CopyButton text={meetingPacket(meeting, prep, own, ended ? 'debrief' : 'prep')} label={ended ? '📋 Copy for Claude (Debrief)' : '📋 Copy for Claude (Prep)'} />
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
        )}

        {error && <div className="mtg-error">{error}</div>}

        {!isThread && (
        <MeetingDocs
          seriesKey={meeting.seriesKey ?? seriesKeyFor(meeting.id)}
          recurring={!!m.recurring}
          inviteLinks={m.links ?? []}
          onChanged={() => window.dispatchEvent(new Event(MEETING_CHANGED_EVENT))}
        />
        )}

        {pasting && (
          <section className="mtg-section mtg-paste">
            <div className="mtg-section__title">Add Meeting Notes</div>
            <p className="mtg-hint">
              Paste the whole response from your work Claude (it ends with a meeting-record block) — or "Notes by Gemini" / any notes. Next steps are pulled out; you decide what each one becomes.
            </p>
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
        {own && own.summaries.some((s) => s.source !== 'own_note' || own.actions.some((a) => a.summaryId === s.id)) && (
          <section className="mtg-section">
            <div className="mtg-section__title mtg-section__title--row">
              <span>{isThread ? 'From This Thread' : 'From This Meeting'}</span>
              {myPending > 0 && (
                <button type="button" className="btn btn--sm" disabled={accepting} onClick={acceptMine}>
                  ✓ Add My {myPending} Task{myPending === 1 ? '' : 's'}
                </button>
              )}
            </div>
            {theirPending > 0 && (
              <div className="mtg-hint">
                {theirPending} for someone else — check each one: Waiting On or Dismiss.
              </div>
            )}
            {own.summaries.filter((s) => s.source !== 'own_note' || own.actions.some((a) => a.summaryId === s.id)).map((s) => (
              <div key={s.id} className="mtg-own">
                {s.source === 'own_note' ? (
                  <div className="mtg-label mtg-own__label">
                    From My Notes{' '}
                    {s.noteEntityId && (
                      <Link className="mtg-link" to={`/notes/${s.noteEntityId}`} onClick={onClose}>
                        Open →
                      </Link>
                    )}
                  </div>
                ) : (
                  <SummaryBlock s={s} />
                )}
                {s.source === 'record' || s.source === 'gemini' || s.source === 'manual' ? (
                  s.noteEntityId && (
                    <Link className="btn btn--sm mtg-readnotes" to={`/notes/${s.noteEntityId}`} onClick={onClose}>
                      📝 Read the Notes
                    </Link>
                  )
                ) : (
                  <ul className="mtg-actions">
                    {own.actions
                      .filter((a) => a.summaryId === s.id)
                      .map((a) => (
                        <ActionRow key={a.id} a={a} assist={assistFor(a)} onChange={(na) => setOwn((o) => (o ? { ...o, actions: updateAction(o.actions, na) } : o))} />
                      ))}
                  </ul>
                )}
                {s.source === 'record' && (
                  <BriefExtras s={s} items={own.items ?? []} assists={own.assists ?? []} suggestions={own.suggestions ?? []} onChanged={load} />
                )}
                {s.source !== 'own_note' && (
                  <button type="button" className="mtg-link mtg-link--quiet" onClick={() => removeSummary(s.id)}>
                    {s.source === 'record' ? 'Remove this brief' : 'Remove these notes'}
                  </button>
                )}
              </div>
            ))}
          </section>
        )}

        {!prep && !error && !isThread && <div className="mtg-hint">Loading prep…</div>}

        {prep?.carryForward && (
          <section className="mtg-section">
            <div className="mtg-section__title mtg-section__title--row">
              <span>Since Last Time · {fmtDay(prep.carryForward.start)}</span>
              {prep.carryForward.noteId && (
                <Link className="mtg-link" to={`/notes/${prep.carryForward.noteId}`} onClick={onClose}>
                  Last time's notes →
                </Link>
              )}
            </div>
            {prep.carryForward.myFollowUps.length > 0 && (
              <div className="mtg-items">
                <div className="mtg-label">What You Did From Those Notes</div>
                <ul className="mtg-items__list">
                  {prep.carryForward.myFollowUps.map((f) => (
                    <li key={f.id} className={`mtg-item${f.done ? ' is-done' : ''}`}>
                      <span className={`mtg-ft mtg-ft--${f.done ? 'done' : 'open'}`}>{f.done ? 'Done' : 'Open'}</span> <span>{f.title.replace(/^Check Back: /, '')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {prep.carryForward.commitments.some((x) => x.isMine) && (
              <div className="mtg-items">
                <div className="mtg-label">Yours From Last Time</div>
                <ul className="mtg-items__list">
                  {prep.carryForward.commitments
                    .filter((x) => x.isMine)
                    .map((x, i) => (
                      <li key={i} className="mtg-item">
                        {x.text}
                        {x.status === 'task' && <span className="mtg-with"> · made a task</span>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {prep.carryForward.commitments.some((x) => !x.isMine) && (
              <details className="mtg-carry">
                <summary>Everyone Else's Next Steps ({prep.carryForward.commitments.filter((x) => !x.isMine).length})</summary>
                <ul className="mtg-items__list">
                  {prep.carryForward.commitments
                    .filter((x) => !x.isMine)
                    .map((x, i) => (
                      <li key={i} className="mtg-item">
                        <strong>{x.owner}:</strong> {x.text}
                        {x.due && <span className="mtg-with"> · due {fmtDue(x.due)}</span>}
                      </li>
                    ))}
                </ul>
              </details>
            )}
            <p className="mtg-hint">Copy for Claude includes all of this, so the next brief reports what got done.</p>
          </section>
        )}

        {prep && (prep.prepItems ?? []).length > 0 && (
          <section className="mtg-section">
            <div className="mtg-section__title">Your Prep</div>
            {['goal', 'talking_point', 'prep_question', 'watch_out'].map((k) => (
              <ItemList key={k} items={prep.prepItems ?? []} kind={k} />
            ))}
          </section>
        )}

        {prep && (prep.stillOpenItems ?? []).length > 0 && (
          <section className="mtg-section">
            <div className="mtg-section__title">Open Questions &amp; Watch-Outs From Earlier</div>
            {['question', 'watch_out'].map((k) => (
              <ItemList
                key={k}
                items={prep.stillOpenItems ?? []}
                kind={k}
                checkable
                onChange={(i) => setPrep((p) => (p ? { ...p, stillOpenItems: (p.stillOpenItems ?? []).filter((x) => x.id !== i.id || !i.resolvedAt) } : p))}
              />
            ))}
          </section>
        )}

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
                      {(p.agenda ?? []).length > 0 && (
                        <div className="mtg-person__block">
                          <div className="mtg-label">To Raise</div>
                          <ul className="person-agenda">
                            {(p.agenda ?? []).map((a) => (
                              <li key={a.id} className={a.doneAt ? 'is-done' : ''}>
                                <input
                                  type="checkbox"
                                  checked={!!a.doneAt}
                                  title="Discussed"
                                  aria-label="Discussed"
                                  onChange={async (e) => {
                                    const r = await api.updatePersonAgenda(a.id, { done: e.target.checked });
                                    setPrep((pp) => (pp ? { ...pp, people: pp.people.map((x) => (x.id === p.id ? { ...x, agenda: (x.agenda ?? []).map((y) => (y.id === a.id ? r : y)) } : x)) } : pp));
                                  }}
                                />
                                <span>{a.text}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
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
                      {!(p.agenda ?? []).length && p.iOwe.length === 0 && p.theyOwe.length === 0 && p.recentNotes.length === 0 && <div className="mtg-hint">Nothing open with {p.name.split(' ')[0]}.</div>}
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
