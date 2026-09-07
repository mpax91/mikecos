import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, TodayResponse, TodayTask } from '../api/types';
import { TaskRow } from '../components/TaskRow';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { BlankLine } from '../components/BlankLine';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Blank ruled lines shown below the day's real tasks — see BlankLine and
 * the matching constant in WeekPage. Kept in sync with that one by eye
 * rather than shared, same as the rest of this page's small date helpers. */
const BLANK_LINES = 10;

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

  useReportTabMeta(isToday ? 'Today' : formatHeaderDate(date), 'today');

  const load = useCallback(() => {
    api.getToday(date).then(setData).catch((e) => setError(String(e)));
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  function goToDate(next: string) {
    navigate(next === todayLocalISO() ? '/today' : `/today/${next}`);
  }

  function switchToWeek() {
    const monday = mondayOf(date);
    navigate(monday === mondayOf(todayLocalISO()) ? '/today/week' : `/today/week/${monday}`);
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

  function renderRow(task: TodayTask) {
    return (
      <TaskRow
        key={task.id}
        entity={task}
        onToggle={toggleTask}
        onDelete={(t) => setDeleting(t)}
        onTogglePin={togglePin}
        onOpen={openTask}
        projectTag={task.project}
      />
    );
  }

  if (error) return <div className="empty-state">Couldn't load today: {error}</div>;

  const overdue = data?.overdue ?? [];
  const dueToday = data?.today ?? [];

  return (
    <div>
      <div className="toolbar-row">
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
              <div className="today-page__list today-page__list--ruled task-list card">{overdue.map(renderRow)}</div>
            </div>
          )}

          <div className="today-page__section">
            {overdue.length > 0 && <div className="today-page__section-title">{isToday ? 'Today' : formatHeaderDate(date)}</div>}
            <div className="today-page__list today-page__list--ruled task-list card">
              {dueToday.map(renderRow)}
              {Array.from({ length: BLANK_LINES }).map((_, i) => (
                <BlankLine key={i} onSubmit={quickAdd} />
              ))}
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
