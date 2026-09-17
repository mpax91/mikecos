import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, Habit, JournalDayResponse, MeetingItem } from '../api/types';
import { NoteEditor } from '../components/NoteEditor';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useReportTabMeta } from '../contexts/TabsContext';
import { meetingHasEnded } from '../utils/meetingNotes';

// Same small pure date helpers TodayPage.tsx already has — kept local and
// duplicated by eye rather than shared, same call TodayPage's own comment
// makes for its copies of these.
function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatHeaderDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatDayHeading(iso: string, isToday: boolean): { heading: string; dateLine: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const monthDay = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  if (isToday) return { heading: 'Today', dateLine: formatHeaderDate(iso) };

  const [ty, tm, td] = todayLocalISO().split('-').map(Number);
  const diffDays = Math.round((dt.getTime() - new Date(ty, tm - 1, td).getTime()) / 86400000);
  const relative = diffDays === 1 ? 'Tomorrow' : diffDays === -1 ? 'Yesterday' : diffDays > 0 ? `In ${diffDays} days` : `${-diffDays} days ago`;
  return { heading: dt.toLocaleDateString('en-US', { weekday: 'long' }), dateLine: `${monthDay} · ${relative}` };
}

const MEETING_TZ = 'America/New_York';
function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: MEETING_TZ, hour: 'numeric', minute: '2-digit' });
}

function formatDueDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One habit's row: name + target on the left, a debounced number input for
 * today's value on the right. A blank input (vs. 0) means "not logged yet" —
 * clearing it back to blank deletes the day's log rather than storing 0, so
 * a habit you didn't get to today doesn't read as "did it, zero times"
 * forever. */
function HabitRow({ habit, date, onLogged }: { habit: Habit; date: string; onLogged: () => void }) {
  const [value, setValue] = useState(habit.log?.value?.toString() ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(habit.log?.value?.toString() ?? '');
  }, [habit.log?.value, date]);

  async function commit(raw: string) {
    setSaving(true);
    try {
      if (raw.trim() === '') {
        await api.deleteHabitLog(habit.id, date);
      } else {
        const num = Number(raw);
        if (Number.isNaN(num)) return;
        await api.logHabit(habit.id, date, num);
      }
      onLogged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="journal-page__habit-row">
      <div className="journal-page__habit-name">
        {habit.name}
        {habit.target_value != null && (
          <span className="journal-page__habit-target">
            {' '}
            (target {habit.target_value}
            {habit.unit ? ` ${habit.unit}` : ''})
          </span>
        )}
      </div>
      <input
        type="number"
        inputMode="decimal"
        className="journal-page__habit-input"
        placeholder="—"
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
      />
      {habit.unit && <span className="journal-page__habit-unit">{habit.unit}</span>}
    </div>
  );
}

function AddHabitRow({ onAdd }: { onAdd: (name: string, unit: string, target: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [target, setTarget] = useState('');

  if (!open) {
    return (
      <button type="button" className="journal-page__add-habit-trigger" onClick={() => setOpen(true)}>
        + Add Habit
      </button>
    );
  }

  return (
    <form
      className="journal-page__add-habit-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim(), unit.trim(), target.trim());
        setName('');
        setUnit('');
        setTarget('');
        setOpen(false);
      }}
    >
      <input className="journal-page__add-habit-input" placeholder="Habit name (e.g. Water)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className="journal-page__add-habit-input journal-page__add-habit-input--small" placeholder="Unit (optional)" value={unit} onChange={(e) => setUnit(e.target.value)} />
      <input className="journal-page__add-habit-input journal-page__add-habit-input--small" placeholder="Target (optional)" type="number" value={target} onChange={(e) => setTarget(e.target.value)} />
      <button type="submit" className="btn">
        Add
      </button>
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** The Journal — a day view that mostly writes itself. Calendar events,
 * completed/pushed tasks, notes, and contact quick-notes are all pulled
 * live from wherever they already live in MikeOS; the only thing actually
 * stored here is the freeform text at the bottom and each day's habit
 * values. Deliberately NOT in this first pass: health data beyond a raw
 * dump (the Google Health export's real fields aren't known yet — see
 * worker/migrations/0020_journal.sql), and finance/gambling tracking
 * (mentioned for a future pass, not this one). */
export function JournalPage() {
  const { date: dateParam } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const date = dateParam ?? todayLocalISO();
  const isToday = date === todayLocalISO();

  const [data, setData] = useState<JournalDayResponse | null>(null);
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Same taskStack-of-ids pattern TodayPage uses to drive TaskDetailModal —
  // a completed or pushed task shown here can still carry a description or
  // attachments worth seeing, so it opens the identical modal rather than
  // just sitting there as inert text.
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Entity | null>(null);

  useReportTabMeta(isToday ? 'Journal' : `Journal — ${formatHeaderDate(date)}`, 'journal');

  const load = useCallback(() => {
    api.getJournalDay(date).then(setData).catch((e) => setError(String(e)));
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMeetings = useCallback(() => {
    api
      .getMeetings(date)
      .then((res) => setMeetings(res.meetings))
      .catch(() => setMeetings([]));
  }, [date]);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  // Journal days are (almost always) in the past, so this is stricter than
  // TodayPage's version: it never creates a note — only opens one that
  // already exists. Mike specifically didn't want a note auto-created for
  // a calendar event that's already happened when browsing back through
  // the Journal.
  async function openMeetingNote(m: MeetingItem) {
    if (!m.hasNote) return;
    const { noteEntityId } = await api.getMeetingNote(m.id);
    // Always top-level (see TodayPage's openMeetingNote comment) —
    // /notes/:id, not /projects/:id, which would show a misleading
    // "Projects" breadcrumb over a note that isn't actually in Projects.
    if (noteEntityId) navigate(`/notes/${noteEntityId}`);
    else loadMeetings(); // stale hasNote (note deleted elsewhere) — refresh so the icon updates
  }

  function openTaskById(id: string) {
    setTaskStack([id]);
  }

  function closeTaskModal() {
    setTaskStack([]);
    load();
  }

  function openSubtask(id: string) {
    setTaskStack((prev) => [...prev, id]);
  }

  function backTask() {
    setTaskStack((prev) => prev.slice(0, -1));
  }

  async function deleteTask(task: Entity) {
    await api.deleteEntity(task.id);
    setDeleting(null);
    load();
  }

  function goToDate(next: string) {
    navigate(next === todayLocalISO() ? '/journal' : `/journal/${next}`);
  }

  async function saveEntry(content: string) {
    await api.updateJournalEntry(date, content);
  }

  async function addHabit(name: string, unit: string, target: string) {
    await api.createHabit(name, unit || null, target ? Number(target) : null);
    load();
  }

  if (error) {
    return (
      <div className="journal-page">
        <div className="empty-state">Couldn't load the journal: {error}</div>
      </div>
    );
  }

  const health = data?.health;
  let healthPreview: Record<string, unknown> | null = null;
  if (health) {
    try {
      healthPreview = JSON.parse(health.raw_data);
    } catch {
      healthPreview = null;
    }
  }

  return (
    <div className="journal-page">
      <div className="today-page__toolbar">
        <div>
          <h1 className="today-page__heading heading-serif">{formatDayHeading(date, isToday).heading}</h1>
          <div className="today-page__date-line">{formatDayHeading(date, isToday).dateLine}</div>
        </div>

        <div className="today-page__nav">
          {!isToday && (
            <button type="button" className="btn btn--ghost" onClick={() => goToDate(todayLocalISO())}>
              Today
            </button>
          )}
          <button type="button" className="today-page__nav-btn" onClick={() => goToDate(addDays(date, -1))} aria-label="Previous day" title="Previous day">
            ‹
          </button>
          <input type="date" className="today-page__date-input" value={date} onChange={(e) => e.target.value && goToDate(e.target.value)} />
          <button type="button" className="today-page__nav-btn" onClick={() => goToDate(addDays(date, 1))} aria-label="Next day" title="Next day">
            ›
          </button>
        </div>
      </div>

      <div className="journal-page__auto card">
        <div className="journal-page__auto-section">
          <div className="journal-page__auto-label">Calendar</div>
          {meetings.length === 0 ? (
            <div className="journal-page__auto-empty">Nothing on the calendar.</div>
          ) : (
            <ul className="journal-page__auto-list journal-page__auto-list--meetings">
              {meetings.map((m) => {
                // Same "at a glance, what's done" signal as the Completed
                // task list right below (✅ prefix) — a meeting counts as
                // done once its end time has passed, same rule TodayPage
                // uses for its strikethrough. Journal entries are usually
                // for a day already over, so this fires for most/all
                // meetings there; still checked against `now` (not just
                // "is this day in the past") so today's journal, opened
                // mid-day, only checks off meetings that have actually
                // ended.
                const done = meetingHasEnded(m);
                return (
                  <li key={m.id} className="journal-page__auto-meeting-row">
                    <span className="journal-page__auto-meeting-text">
                      {done && <span aria-hidden="true">✅ </span>}
                      <span className="journal-page__auto-time">{formatMeetingTime(m.start)}</span> {m.title}
                    </span>
                    <span className="today-page__meeting-actions">
                      <a
                        className="today-page__meeting-icon-btn"
                        href={m.gcalUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        title="Open in Google Calendar"
                        aria-disabled={!m.gcalUrl}
                        onClick={(e) => {
                          if (!m.gcalUrl) e.preventDefault();
                        }}
                      >
                        📅
                      </a>
                      <button
                        type="button"
                        className={`today-page__meeting-icon-btn${m.hasNote ? ' today-page__meeting-icon-btn--active' : ''}`}
                        title={m.hasNote ? 'Open note' : 'No note for this meeting'}
                        aria-disabled={!m.hasNote}
                        onClick={() => openMeetingNote(m)}
                      >
                        📝
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="journal-page__auto-section">
          <div className="journal-page__auto-label">Completed</div>
          {!data || data.tasksCompleted.length === 0 ? (
            <div className="journal-page__auto-empty">Nothing checked off.</div>
          ) : (
            <ul className="journal-page__auto-list">
              {data.tasksCompleted.map((t) => (
                <li key={t.id} className="journal-page__auto-clickable" onClick={() => openTaskById(t.entity_id)}>
                  ✅ {t.title}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="journal-page__auto-section">
          <div className="journal-page__auto-label">Pushed</div>
          {!data || data.tasksPushed.length === 0 ? (
            <div className="journal-page__auto-empty">Nothing pushed.</div>
          ) : (
            <ul className="journal-page__auto-list">
              {data.tasksPushed.map((t) => (
                <li key={t.id} className="journal-page__auto-clickable" onClick={() => openTaskById(t.entity_id)}>
                  ↪️ {t.title} <span className="journal-page__auto-hint">({formatDueDate(t.from_due_date)} → {formatDueDate(t.to_due_date)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="journal-page__auto-section">
          <div className="journal-page__auto-label">Notes</div>
          {!data || data.notes.length === 0 ? (
            <div className="journal-page__auto-empty">No notes made.</div>
          ) : (
            <ul className="journal-page__auto-list">
              {data.notes.map((n) => (
                <li key={n.id}>
                  {/* /notes/:id only ever resolves a top-level note — one
                      nested inside a project (like this one apparently
                      buried in Job Search) has to go through /projects/:id
                      instead, since that page is generic over entity type
                      and walks parent_id to build the breadcrumb. Getting
                      this wrong is exactly the "Doctronic note goes to a
                      blank Notes page" bug. */}
                  <Link to={n.is_top_level ? `/notes/${n.id}` : `/projects/${n.id}`}>
                    {n.is_jot ? '🗒️' : '📝'} {n.title || 'Untitled'}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="journal-page__auto-section">
          <div className="journal-page__auto-label">Contacts</div>
          {!data || data.contactNotes.length === 0 ? (
            <div className="journal-page__auto-empty">No contact notes added.</div>
          ) : (
            <ul className="journal-page__auto-list">
              {data.contactNotes.map((n) => (
                <li key={n.id}>
                  <Link to={`/contacts/${n.contact_id}`}>{n.contact_name}</Link>: {n.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {health && (
          <div className="journal-page__auto-section">
            <div className="journal-page__auto-label">Health</div>
            <div className="journal-page__auto-hint">
              From your last Google Health upload — may not be from this exact day if the upload lags.
            </div>
            {healthPreview && (
              <ul className="journal-page__auto-list">
                {Object.entries(healthPreview).slice(0, 8).map(([k, v]) => (
                  <li key={k}>
                    {k}: {String(v)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="journal-page__habits card">
        <div className="journal-page__auto-label">Habits</div>
        {(data?.habits ?? []).map((h) => (
          <HabitRow key={h.id} habit={h} date={date} onLogged={load} />
        ))}
        <AddHabitRow onAdd={addHabit} />
      </div>

      <div className="journal-page__freeform card">
        <div className="journal-page__auto-label">Notes for the Day</div>
        {data && <NoteEditor key={date} content={data.entry?.content ?? null} onSave={saveEntry} />}
      </div>

      {taskStack.length > 0 && (
        <TaskDetailModal
          key={taskStack[taskStack.length - 1]}
          taskId={taskStack[taskStack.length - 1]}
          onBack={taskStack.length > 1 ? backTask : undefined}
          onClose={closeTaskModal}
          onOpenSubtask={openSubtask}
          onMutated={load}
          onRequestDelete={(entityToDelete) => {
            setTaskStack([]);
            setDeleting(entityToDelete);
          }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete task?"
          body={`"${deleting.title || 'Untitled'}" will be permanently deleted.`}
          onConfirm={() => deleteTask(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
