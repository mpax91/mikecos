import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, MeetingItem, StatsResponse, TodayResponse, TodayTask, WeatherDay } from '../api/types';
import { TaskRow } from '../components/TaskRow';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { BlankLine } from '../components/BlankLine';
import { WeatherWidget } from '../components/WeatherWidget';
import { getHolidays } from '../utils/holidays';
import { buildMeetingNoteTitle, meetingHasEnded } from '../utils/meetingNotes';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Default number of rows (real tasks + blank ruled lines combined) shown
 * before Mike has to explicitly ask for more — see the "+ Add another line"
 * control. A day with 3 tasks gets 7 blanks; a day with 12 tasks gets none
 * (its real tasks already exceed the default) rather than forcing it back
 * down to 10. Kept in sync with WeekPage's per-column blank count by eye
 * rather than shared, same as the rest of this page's small date helpers. */
const DEFAULT_ROWS = 10;

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

/** Big heading + small date-line pair for the page header — "Today" reads
 * as a name up top with the actual date underneath, the same relationship
 * a paper planner's page has between its printed weekday and the date you
 * write in yourself. A day that isn't today gets its weekday name as the
 * big heading instead, with the full date and how far off it is below. */
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

/** The Monday on or before `iso` — matches WeekPage's own anchoring, so
 * switching from Day to Week always lands on the week containing the day
 * currently being viewed. */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + offset);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Meeting times are shown in Mike's home timezone specifically (rather
// than the viewing device's own zone) — same as the weather widget's fixed
// Bedford Hills, NY location, so a meeting at "1pm" reads the same whether
// he's looking at this from his desktop at home or his phone on the road.
const MEETING_TZ = 'America/New_York';
function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: MEETING_TZ, hour: 'numeric', minute: '2-digit' });
}

/** The daily planner — Phase 1: every open task due on or before the viewed
 * date, pulled from every project (plus standalone tasks with no project),
 * split into Overdue and the viewed day itself. Checking one off here
 * updates the very same task row a project would show — there's no
 * separate copy to keep in sync. Viewing a past date asks the identical
 * question ("what was outstanding as of then"), which is what makes a
 * history view fall out for free instead of needing its own storage.
 *
 * Deliberately NOT in this first pass: recurring tasks, habit tracking, the
 * stale-item "Revisit" tickler, and Google Calendar — each is its own
 * follow-up phase once this core loop is solid. */
export function TodayPage() {
  const { date: dateParam } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const date = dateParam ?? todayLocalISO();
  const isToday = date === todayLocalISO();

  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [weather, setWeather] = useState<WeatherDay | undefined>(undefined);
  const [extraRows, setExtraRows] = useState(0);
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useReportTabMeta(isToday ? 'Today' : formatHeaderDate(date), 'today');

  const load = useCallback(() => {
    api.getToday(date, todayLocalISO()).then(setData).catch((e) => setError(String(e)));
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  // Completion count for the viewed day (see the Important Dates note above
  // — "date" here means whatever day is on screen, not necessarily the real
  // wall-clock today, same as everything else on this page). A separate,
  // best-effort fetch rather than folding into /api/today — a stats hiccup
  // shouldn't take the task list down with it.
  const loadStats = useCallback(() => {
    api.getStats(date).then(setStats).catch(() => setStats(null));
  }, [date]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // A fresh default row count on every date switch — "add another line" is
  // a per-day decision, not something that should carry over to the next
  // day viewed.
  useEffect(() => {
    setExtraRows(0);
  }, [date]);

  // Same forecast fetch as WeekPage — only this page's one viewed date gets
  // used, but re-fetching per date isn't worth a separate endpoint shape.
  // Silently absent (no widget rendered) for dates outside the ~16-day
  // window, same as the Week view.
  useEffect(() => {
    api
      .getWeather()
      .then((res) => setWeather(res.days.find((d) => d.date === date)))
      .catch(() => setWeather(undefined));
  }, [date]);

  // Real Google Calendar events, separate from the task data above — a
  // failed/unconfigured fetch just means an empty section rather than
  // blocking the rest of the page (same "nice-to-have overlay" treatment
  // as weather). Pulled into its own callback (rather than inline in the
  // effect) so saving/deleting a meeting note can re-fetch and pick up the
  // updated hasNote flag without touching anything else on the page.
  const loadMeetings = useCallback(() => {
    api
      .getMeetings(date)
      .then((res) => setMeetings(res.meetings))
      .catch(() => setMeetings([]));
  }, [date]);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  // The note icon on a meeting row — opens the real note already linked to
  // this meeting, or (only for a meeting that hasn't happened yet) creates
  // one, titled from the meeting itself, and opens that. A meeting that's
  // already over and has no note just does nothing (see the icon's
  // aria-disabled state below) — Mike doesn't want a note auto-created for
  // something that's already passed.
  async function openMeetingNote(m: MeetingItem) {
    if (m.hasNote) {
      const { noteEntityId } = await api.getMeetingNote(m.id);
      if (noteEntityId) {
        // Always top-level (created via POST /api/meetings/:id/note, which
        // never nests it under a project) — /notes/:id is the right route,
        // not /projects/:id. That generic route works for any entity type,
        // but its Breadcrumb component always shows a leading "Projects"
        // crumb, which reads as this note living inside Projects when it
        // doesn't.
        navigate(`/notes/${noteEntityId}`);
        return;
      }
      // hasNote was stale (the note was deleted from the Notes page
      // itself, which knows nothing about this linkage) — the worker
      // already dropped the dangling link; refresh so the icon stops
      // showing filled, then fall through below.
      loadMeetings();
    }
    if (meetingHasEnded(m)) return;
    const { noteEntityId } = await api.createMeetingNote(m.id, buildMeetingNoteTitle(m));
    navigate(`/notes/${noteEntityId}`);
    loadMeetings();
  }

  function goToDate(next: string) {
    navigate(next === todayLocalISO() ? '/today' : `/today/${next}`);
  }

  const weekStart = mondayOf(date);
  function switchToWeek() {
    navigate(weekStart === mondayOf(todayLocalISO()) ? '/today/week' : `/today/week/${weekStart}`);
  }

  function switchToMonth() {
    const month = date.slice(0, 7);
    navigate(month === todayLocalISO().slice(0, 7) ? '/today/month' : `/today/month/${month}`);
  }

  async function quickAdd(title: string) {
    await api.createStandaloneTask(title, date);
    load();
  }

  // Every task shown here is currently open (that's what the query behind
  // /api/today asks for) — so toggling one always means marking it done and
  // dropping it off this list, never the reverse.
  async function toggleTask(task: Entity) {
    setData((prev) =>
      prev
        ? { ...prev, overdue: prev.overdue.filter((t) => t.id !== task.id), today: prev.today.filter((t) => t.id !== task.id) }
        : prev
    );
    await api.updateEntity(task.id, { status: 'done' });
    load();
    loadStats();
  }

  async function deleteTask(task: Entity) {
    setData((prev) =>
      prev
        ? { ...prev, overdue: prev.overdue.filter((t) => t.id !== task.id), today: prev.today.filter((t) => t.id !== task.id) }
        : prev
    );
    await api.deleteEntity(task.id);
    setDeleting(null);
  }

  async function togglePin(task: Entity) {
    await api.setPinned(task.id, task.pinned !== 1);
    load();
  }

  function openTask(task: Entity) {
    setTaskStack([task.id]);
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

  // Promote/demote among today's own tasks — a plain swap-with-neighbor
  // reorder, persisted via api.reorderDay (scoped by due_date, not
  // parent_id, since this list mixes tasks pulled from many different
  // projects that don't share a parent — see the worker's
  // /api/tasks/reorder-day comment). Deliberately only offered on the
  // exact-due-today bucket: Overdue mixes several different due dates, so
  // "promote" there wouldn't have a coherent meaning.
  function persistDayReorder(orderedIds: string[]) {
    api.reorderDay(date, orderedIds).then(load);
  }

  function promoteTask(task: Entity) {
    const group = data?.today ?? [];
    const idx = group.findIndex((t) => t.id === task.id);
    if (idx <= 0) return;
    const ordered = [...group];
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    persistDayReorder(ordered.map((t) => t.id));
  }

  function demoteTask(task: Entity) {
    const group = data?.today ?? [];
    const idx = group.findIndex((t) => t.id === task.id);
    if (idx === -1 || idx >= group.length - 1) return;
    const ordered = [...group];
    [ordered[idx], ordered[idx + 1]] = [ordered[idx + 1], ordered[idx]];
    persistDayReorder(ordered.map((t) => t.id));
  }

  // `reorderable` gates Promote/Demote to the exact-due-today list only —
  // Overdue mixes several different due dates, so swapping two of its rows
  // wouldn't have a coherent meaning (and persistDayReorder operates on
  // data.today specifically, so it would silently no-op there anyway).
  function renderRow(task: TodayTask, reorderable = false) {
    return (
      <TaskRow
        key={task.id}
        entity={task}
        onToggle={toggleTask}
        onDelete={(t) => setDeleting(t)}
        onTogglePin={togglePin}
        onOpen={openTask}
        onPromote={reorderable ? promoteTask : undefined}
        onDemote={reorderable ? demoteTask : undefined}
        projectTag={task.project}
      />
    );
  }

  if (error) return <div className="empty-state">Couldn't load today: {error}</div>;

  const overdue = data?.overdue ?? [];
  const dueToday = data?.today ?? [];
  const spotlight = data?.spotlight ?? null;
  const completed = data?.completed ?? [];

  const holidays = getHolidays(date);
  const blankCount = Math.max(0, DEFAULT_ROWS + extraRows - dueToday.length - completed.length);

  // Birthdays and anniversaries for the viewed day, combined into one list
  // (sorted by name) for the Important Dates panel — see /api/today.
  const importantDateContacts = [
    ...(data?.birthdays ?? []).map((contact) => ({ contact, kind: 'birthday' as const })),
    ...(data?.anniversaries ?? []).map((contact) => ({ contact, kind: 'anniversary' as const })),
  ].sort((a, b) => a.contact.name.localeCompare(b.contact.name));
  // Split so the panel leads with people Mike actually knows — a personal
  // contact he saved himself — and tucks voter-roll-only matches (which can
  // be a couple dozen strangers sharing a birthday) behind a fold rather
  // than burying the actionable names in a long, mostly-unfamiliar list.
  const personalDateContacts = importantDateContacts.filter((d) => d.contact.source !== 'voter_file');
  const voterDateContacts = importantDateContacts.filter((d) => d.contact.source === 'voter_file');

  return (
    <div>
      {/* A 3-column grid rather than the shared .toolbar-row's flex
          space-between — with three unequal-width groups, space-between
          only pushes the outer two to the edges and leaves the middle one
          wherever its neighbors' widths happen to land it, not truly
          centered. The Day/Week/Month + date nav is the thing worth
          keeping visually centered regardless of how wide the heading or
          the completion/weather badges get. */}
      <div className="today-page__toolbar">
        <div>
          <h1 className="today-page__heading heading-serif">{formatDayHeading(date, isToday).heading}</h1>
          <div className="today-page__date-line">{formatDayHeading(date, isToday).dateLine}</div>
        </div>

        <div className="today-page__nav">
          <div className="today-page__view-toggle">
            <button type="button" className="today-page__view-btn is-active">
              Day
            </button>
            <button type="button" className="today-page__view-btn" onClick={switchToWeek}>
              Week
            </button>
            <button type="button" className="today-page__view-btn" onClick={switchToMonth}>
              Month
            </button>
          </div>
          <button type="button" className="today-page__nav-btn" onClick={() => goToDate(addDays(date, -1))} aria-label="Previous day" title="Previous day">
            ‹
          </button>
          <input
            type="date"
            className="today-page__date-input"
            value={date}
            onChange={(e) => e.target.value && goToDate(e.target.value)}
          />
          <button type="button" className="today-page__nav-btn" onClick={() => goToDate(addDays(date, 1))} aria-label="Next day" title="Next day">
            ›
          </button>
          {/* Reserved-width slot (see .today-page__today-slot) rather than a
             conditionally-mounted element — so the date-nav trio to its left
             never reflows when this appears/disappears; it just fades in in
             place, sitting outside the Day/Week/Month + arrows/date group as
             a separate "jump back" action rather than wedged inside it. */}
          <span className={`today-page__today-slot${!isToday ? ' is-visible' : ''}`}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => goToDate(todayLocalISO())}>
              Today
            </button>
          </span>
        </div>

        <div className="today-page__header-extra">
          {holidays.length > 0 && <div className="today-page__holiday-badge">🎉 {holidays.join(' · ')}</div>}
          {/* Always shown, even at zero — a "0 Completed Today" badge is a
              nudge in its own right (unlike the holiday badge above, which
              genuinely has nothing to say on a non-holiday), so it stays
              visible instead of only confirming after the fact. */}
          {stats !== null && (
            <Link to="/stats" className="today-page__stats-badge" title="See completion stats">
              ✅ {stats.today} Completed {isToday ? 'Today' : 'That Day'}
            </Link>
          )}
          <WeatherWidget day={weather} variant="sentence" />
        </div>
      </div>

      {data === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="today-page__body">
          {overdue.length > 0 && (
            <div className="today-page__section">
              <div className="today-page__section-title today-page__section-title--overdue">
                Overdue ({overdue.length})
              </div>
              <div className="today-page__list today-page__list--ruled task-list card">{overdue.map((task) => renderRow(task))}</div>
            </div>
          )}

          {/* Always shown, even with nothing to list — a section that only
              sometimes appears reads as broken/loading rather than "no
              meetings today", and every other Day view section (Important
              Dates, the task list itself) is a fixed part of the page's
              shape the same way. */}
          <div className="today-page__section">
            <div className="today-page__section-title">{isToday ? "Today's Meetings" : 'Meetings'}</div>
            {meetings.length === 0 ? (
              <div className="today-page__meetings card">
                <div className="empty-state">No meetings {isToday ? 'today' : 'that day'}.</div>
              </div>
            ) : (
              <div className="today-page__meetings card">
                {meetings.map((m) => (
                  <div
                    key={m.id}
                    className={
                      // Was gated on isToday — a past meeting on a past day
                      // never got the strikethrough. That's whatever day is
                      // actually on screen ending before "now", same rule
                      // as before, just no longer restricted to today.
                      !m.allDay && new Date(m.end).getTime() <= Date.now()
                        ? 'today-page__meeting-row today-page__meeting-row--past'
                        : 'today-page__meeting-row'
                    }
                  >
                    <span className="today-page__meeting-time">{m.allDay ? 'All day' : formatMeetingTime(m.start)}</span>
                    <span className="today-page__meeting-title">{m.title}</span>
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
                        title={m.hasNote ? 'Open note' : meetingHasEnded(m) ? 'No note for this meeting' : 'Create note'}
                        aria-disabled={!m.hasNote && meetingHasEnded(m)}
                        onClick={() => {
                          if (!m.hasNote && meetingHasEnded(m)) return;
                          openMeetingNote(m);
                        }}
                      >
                        📝
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="today-page__section">
            {overdue.length > 0 && <div className="today-page__section-title">{isToday ? 'Today' : formatHeaderDate(date)}</div>}
            <div className="today-page__list today-page__list--ruled task-list card">
              {dueToday.map((task) => renderRow(task, true))}
              {/* What got checked off that day, shown struck through at the
                  bottom of the same list rather than just vanishing (or
                  living in a separate section below) — matches how Week
                  view already shows a day's completions inline in its
                  column. Read-only row (checked checkbox, no toggle/pin/
                  delete) since un-completing isn't a thing this list
                  supports; clicking still opens the same task-detail modal
                  every other row here does, since a completed task can
                  still carry a description or attachments worth seeing. */}
              {completed.map((t) => (
                <div key={t.id} className="task-row" onClick={() => setTaskStack([t.entity_id])}>
                  <input type="checkbox" checked readOnly className="task-row__checkbox" onClick={(e) => e.stopPropagation()} />
                  <span className="task-row__title is-done">{t.title || 'Untitled Task'}</span>
                </div>
              ))}
              {Array.from({ length: blankCount }).map((_, i) => (
                <BlankLine key={i} onSubmit={quickAdd} />
              ))}
            </div>
            <button type="button" className="today-page__add-row-btn" onClick={() => setExtraRows((n) => n + 1)}>
              + Add another line
            </button>
          </div>

          {/* One open, unscheduled task (no due date at all), rotating to a
              different pick each calendar day — see computeSpotlight on the
              worker. Rendered as an ordinary TaskRow (same checkbox/pin/
              delete/project-tag as the list above) so checking it off here
              works exactly like checking it off anywhere else, rather than
              being a dead-end nudge. */}
          {spotlight && (
            <div className="today-page__section">
              <div className="today-page__section-title">Worth Revisiting</div>
              <div className="today-page__list task-list card">{renderRow(spotlight)}</div>
            </div>
          )}

          <div className="today-page__section">
            <div className="today-page__section-title">Important Dates</div>
            <div className="today-page__important-dates card">
              <div className="today-page__important-dates-group">
                <div className="today-page__important-dates-group-title">Birthdays &amp; Anniversaries</div>
                {/* Same-day-only match, like the Holidays group below (both
                    read off the exact viewed date, not a look-ahead
                    window) — see /api/today's birthdays/anniversaries,
                    matched by contacts.birthday_month/day (year optional). */}
                {personalDateContacts.length === 0 ? (
                  <div className="today-page__important-dates-empty">
                    {voterDateContacts.length === 0 ? 'Nothing today.' : 'No personal contacts today.'}
                  </div>
                ) : (
                  <div className="today-page__important-dates-list">
                    {personalDateContacts.map(({ contact, kind }) => (
                      <Link
                        key={`${kind}-${contact.id}`}
                        to={`/contacts/${contact.id}`}
                        className="today-page__important-dates-row"
                      >
                        <span className="today-page__important-dates-name">{contact.name}</span>
                        <span className="today-page__important-dates-kind">
                          {kind === 'birthday' ? '🎂 Birthday' : '💍 Anniversary'}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
                {/* Voter-roll matches are usually people Mike doesn't
                    personally know — sometimes a couple dozen of them on
                    one day. No fold/toggle: a divider marks the split and
                    everything below it is just listed out, rendered a size
                    down and muted throughout so the personal list above
                    still reads as "the important part" even on a
                    32-name day. */}
                {voterDateContacts.length > 0 && (
                  <div className="today-page__important-dates-voters">
                    <hr className="today-page__important-dates-divider" />
                    <div className="today-page__important-dates-list">
                      {voterDateContacts.map(({ contact, kind }) => (
                        <Link
                          key={`${kind}-${contact.id}`}
                          to={`/contacts/${contact.id}`}
                          className="today-page__important-dates-row today-page__important-dates-row--voter"
                        >
                          <span className="today-page__important-dates-name">
                            <span className="today-page__important-dates-source" title="From the voter roll, not a saved contact">
                              🗳️{' '}
                            </span>
                            {contact.name}
                          </span>
                          <span className="today-page__important-dates-kind">
                            {kind === 'birthday' ? '🎂' : '💍'}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="today-page__important-dates-group">
                <div className="today-page__important-dates-group-title">Holidays</div>
                {/* Scoped to just this one viewed day, same as the header
                    badge (both read off the same getHolidays(date) list) —
                    a look-ahead list here would duplicate what the Week
                    view's per-column holiday line already shows. */}
                {holidays.length === 0 ? (
                  <div className="today-page__important-dates-empty">Nothing today.</div>
                ) : (
                  <div className="today-page__important-dates-list">
                    {holidays.map((name) => (
                      <div key={name} className="today-page__important-dates-row">
                        <span className="today-page__important-dates-name">{name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete task?"
          body={`"${deleting.title || 'Untitled'}" will be permanently deleted.`}
          onConfirm={() => deleteTask(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

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
    </div>
  );
}
