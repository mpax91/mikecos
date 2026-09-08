import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, MeetingItem, StatsResponse, TicklerItem, TodayResponse, TodayTask, WeatherDay } from '../api/types';
import { TaskRow } from '../components/TaskRow';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { BlankLine } from '../components/BlankLine';
import { WeatherWidget } from '../components/WeatherWidget';
import { getHolidays } from '../utils/holidays';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Default number of rows (real tasks + blank ruled lines combined) shown
 * before Mike has to explicitly ask for more — see the "+ Add another line"
 * control. A day with 3 tasks gets 7 blanks; a day with 12 tasks gets none
 * (its real tasks already exceed the default) rather than forcing it back
 * down to 10. Kept in sync with WeekPage's per-column blank count by eye
 * rather than shared, same as the rest of this page's small date helpers. */
const DEFAULT_ROWS = 10;

const TICKLER_LABEL: Record<TicklerItem['staleness'], string> = {
  jot: 'Untouched jot',
  note: 'Untouched note',
};

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

function formatShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  // as weather).
  useEffect(() => {
    api
      .getMeetings(date)
      .then((res) => setMeetings(res.meetings))
      .catch(() => setMeetings([]));
  }, [date]);

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

  // The Tickler surfaces notes and jots, not tasks — opening one in the
  // task-detail sidebar (openTask's modal, built for editing a task) was
  // never right for them. A note has its own real page to go to; a jot
  // doesn't have a URL of its own yet (JotsPage selects one via in-page
  // state, not a route param), so the best available fix today is landing
  // on the Jots list rather than the wrong sidebar.
  function openTickler(item: TicklerItem) {
    if (item.staleness === 'note') navigate(`/notes/${item.id}`);
    else navigate('/jots');
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
  const tickler = data?.tickler ?? [];

  const holidays = getHolidays(date);
  const blankCount = Math.max(0, DEFAULT_ROWS + extraRows - dueToday.length);

  return (
    <div>
      <div className="breadcrumb">
        <button
          type="button"
          className="breadcrumb__back"
          onClick={() => navigate(weekStart === mondayOf(todayLocalISO()) ? '/today/week' : `/today/week/${weekStart}`)}
          title="Back to week"
          aria-label="Back to week"
        >
          ‹
        </button>
        <Link to={weekStart === mondayOf(todayLocalISO()) ? '/today/week' : `/today/week/${weekStart}`} className="breadcrumb__link">
          Week of {formatShort(weekStart)} – {formatShort(addDays(weekStart, 6))}
        </Link>
      </div>

      <div className="toolbar-row">
        <div>
          <h1 className="today-page__heading heading-serif">{formatDayHeading(date, isToday).heading}</h1>
          <div className="today-page__date-line">{formatDayHeading(date, isToday).dateLine}</div>
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
          {!isToday && (
            <button type="button" className="btn btn--ghost" onClick={() => goToDate(todayLocalISO())}>
              Today
            </button>
          )}
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
              <div className="empty-state">No meetings {isToday ? 'today' : 'that day'}.</div>
            ) : (
              <div className="today-page__meetings card">
                {meetings.map((m) => (
                  <a
                    key={m.id}
                    className="today-page__meeting-row"
                    href={m.gcalUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!m.gcalUrl) e.preventDefault();
                    }}
                  >
                    <span className="today-page__meeting-time">{m.allDay ? 'All day' : formatMeetingTime(m.start)}</span>
                    <span className="today-page__meeting-title">{m.title}</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="today-page__section">
            {overdue.length > 0 && <div className="today-page__section-title">{isToday ? 'Today' : formatHeaderDate(date)}</div>}
            <div className="today-page__list today-page__list--ruled task-list card">
              {dueToday.map((task) => renderRow(task, true))}
              {Array.from({ length: blankCount }).map((_, i) => (
                <BlankLine key={i} onSubmit={quickAdd} />
              ))}
            </div>
            <button type="button" className="today-page__add-row-btn" onClick={() => setExtraRows((n) => n + 1)}>
              + Add another line
            </button>
          </div>

          {tickler.length > 0 && (
            <div className="today-page__section">
              <div className="today-page__section-title">Worth revisiting</div>
              <div className="today-page__tickler card">
                {tickler.map((t) => (
                  <div key={t.id} className="today-page__tickler-row" onClick={() => openTickler(t)}>
                    <span className="today-page__tickler-title">{t.title || 'Untitled'}</span>
                    <span className="today-page__tickler-badge">{TICKLER_LABEL[t.staleness]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="today-page__section">
            <div className="today-page__section-title">Important Dates</div>
            <div className="today-page__important-dates card">
              <div className="today-page__important-dates-group">
                <div className="today-page__important-dates-group-title">Birthdays &amp; Anniversaries</div>
                {/* Placeholder — no contacts/CRM data model yet. Once one
                    exists, this surfaces upcoming birthdays and
                    anniversaries the same way the Holidays group below
                    surfaces observances, rather than being a separate
                    build. */}
                <div className="today-page__important-dates-empty">
                  No contacts yet — birthdays and anniversaries will show up here once MikeOS has a CRM.
                </div>
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
