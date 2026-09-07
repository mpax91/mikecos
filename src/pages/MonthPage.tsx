import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, MonthResponse, TodayTask } from '../api/types';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { getHolidays } from '../utils/holidays';
import { useReportTabMeta } from '../contexts/TabsContext';

/** How many task rows a cell shows before collapsing the rest into a
 * "+N more" — Google Calendar's own month grid does the same thing, and a
 * MikeOS day can easily have more tasks than 3 rows' worth of vertical
 * room in a 6-row-tall grid. */
const MAX_VISIBLE_PER_CELL = 3;

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

/** 'YYYY-MM' for whichever month contains `iso` — the anchor this page's
 * URL param is built from. */
function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** The 1st of `yearMonth` ('YYYY-MM'), as a full ISO date. */
function firstOfMonth(yearMonth: string): string {
  return `${yearMonth}-01`;
}

function addMonths(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthHeading(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** The Sunday on/before `iso` — Month view follows Google Calendar's own
 * Sunday-first grid rather than the Monday-first convention Day/Week use
 * (a physical weekly planner), since Mike asked for this to read like
 * Google Calendar specifically. */
function sundayOnOrBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dt.getDay());
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function lastOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const dt = new Date(y, m, 0); // day 0 of next month = last day of this one
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatDayNum(iso: string): number {
  return Number(iso.slice(8, 10));
}

const WEEKDAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function MonthTaskRow({ task, onToggle, onOpen }: { task: TodayTask; onToggle: (t: Entity) => void; onOpen: (t: Entity) => void }) {
  return (
    <div
      className="month-page__task"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(task);
      }}
    >
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={(e) => {
          e.stopPropagation();
          onToggle(task);
        }}
        onClick={(e) => e.stopPropagation()}
        className="month-page__task-checkbox"
      />
      <span className="month-page__task-title">{task.title || 'Untitled Task'}</span>
    </div>
  );
}

/** Month view — a Google-Calendar-style grid: every day of the visible
 * month (plus the previous/next month's spillover days needed to fill a
 * whole 7-column grid), each cell showing that day's holiday (if any) and
 * up to a handful of tasks due that day, with the rest collapsed into a
 * "+N more". It's a bird's-eye look at what's coming, not a place to work
 * the backlog — no Overdue, Tickler, or Unscheduled shelf here, and no
 * blank ruled lines to fill in; those all stay on Day/Week. Clicking a
 * task opens it in the same detail sidebar Day/Week use; clicking anywhere
 * else in a cell opens that day's Day view. */
export function MonthPage() {
  const { month: monthParam } = useParams<{ month: string }>();
  const navigate = useNavigate();
  const realToday = todayLocalISO();
  const month = monthParam ?? monthOf(realToday);

  const [data, setData] = useState<MonthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);

  useReportTabMeta(formatMonthHeading(month), 'today');

  const gridStart = sundayOnOrBefore(firstOfMonth(month));
  // The grid always runs a whole number of 7-day weeks from gridStart
  // through the Saturday on/after the month's last day — 5 rows most
  // months, 6 when the month starts late in its first week.
  const gridEnd = (() => {
    const last = lastOfMonth(month);
    const [y, m, d] = last.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + (6 - dt.getDay()));
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  })();

  const load = useCallback(() => {
    api.getMonth(gridStart, gridEnd).then(setData).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStart, gridEnd]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setExpandedCell(null);
  }, [month]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, TodayTask[]>();
    if (!data) return map;
    for (const t of data.tasks) {
      const list = map.get(t.due_date!);
      if (list) list.push(t);
      else map.set(t.due_date!, [t]);
    }
    return map;
  }, [data]);

  const gridDates = useMemo(() => {
    const dates: string[] = [];
    let cursor = gridStart;
    while (cursor <= gridEnd) {
      dates.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return dates;
  }, [gridStart, gridEnd]);

  function goToMonth(nextMonth: string) {
    navigate(nextMonth === monthOf(realToday) ? '/today/month' : `/today/month/${nextMonth}`);
  }

  function switchToDay() {
    navigate(month === monthOf(realToday) ? '/today' : `/today/${firstOfMonth(month)}`);
  }

  function switchToWeek() {
    navigate(`/today/week/${sundayOnOrBefore(firstOfMonth(month))}`);
  }

  function openDay(date: string) {
    navigate(date === realToday ? '/today' : `/today/${date}`);
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

  async function toggleTask(task: Entity) {
    const next = task.status === 'done' ? 'open' : 'done';
    setData((prev) => (prev ? { ...prev, tasks: prev.tasks.filter((t) => t.id !== task.id || next !== 'done') } : prev));
    await api.updateEntity(task.id, { status: next });
    load();
  }

  async function deleteTask(task: Entity) {
    setData((prev) => (prev ? { ...prev, tasks: prev.tasks.filter((t) => t.id !== task.id) } : prev));
    await api.deleteEntity(task.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load this month: {error}</div>;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          {formatMonthHeading(month)}
        </h1>
        <div className="today-page__nav">
          <div className="today-page__view-toggle">
            <button type="button" className="today-page__view-btn" onClick={switchToDay}>
              Day
            </button>
            <button type="button" className="today-page__view-btn" onClick={switchToWeek}>
              Week
            </button>
            <button type="button" className="today-page__view-btn is-active">
              Month
            </button>
          </div>
          {month !== monthOf(realToday) && (
            <button type="button" className="btn btn--ghost" onClick={() => goToMonth(monthOf(realToday))}>
              This Month
            </button>
          )}
          <button type="button" className="today-page__nav-btn" onClick={() => goToMonth(addMonths(month, -1))} aria-label="Previous month" title="Previous month">
            ‹
          </button>
          <button type="button" className="today-page__nav-btn" onClick={() => goToMonth(addMonths(month, 1))} aria-label="Next month" title="Next month">
            ›
          </button>
        </div>
      </div>

      {data === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="month-page">
          <div className="month-page__weekday-row">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="month-page__weekday-label">
                {label}
              </div>
            ))}
          </div>
          <div className="month-page__grid">
            {gridDates.map((date) => {
              const inMonth = monthOf(date) === month;
              const isToday = date === realToday;
              const holidays = getHolidays(date);
              const tasks = tasksByDate.get(date) ?? [];
              const expanded = expandedCell === date;
              const visible = expanded ? tasks : tasks.slice(0, MAX_VISIBLE_PER_CELL);
              const hiddenCount = tasks.length - visible.length;

              return (
                <div
                  key={date}
                  className={`month-page__cell${inMonth ? '' : ' is-outside-month'}${isToday ? ' is-today' : ''}`}
                  onClick={() => openDay(date)}
                >
                  <div className="month-page__cell-header">
                    <span className={`month-page__cell-date${isToday ? ' is-today' : ''}`}>{formatDayNum(date)}</span>
                  </div>
                  {holidays.length > 0 && <div className="month-page__cell-holiday">{holidays.join(' · ')}</div>}
                  {visible.length > 0 && (
                    <div className="month-page__cell-tasks">
                      {visible.map((t) => (
                        <MonthTaskRow key={t.id} task={t} onToggle={toggleTask} onOpen={openTask} />
                      ))}
                    </div>
                  )}
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      className="month-page__more-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedCell(date);
                      }}
                    >
                      +{hiddenCount} more
                    </button>
                  )}
                </div>
              );
            })}
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
