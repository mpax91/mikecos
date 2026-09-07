import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, TicklerItem, TodayTask, WeekResponse } from '../api/types';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useReportTabMeta } from '../contexts/TabsContext';

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

/** The Monday on or before `iso` — every week view is anchored to a Monday,
 * matching a physical weekly planner's layout. */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0 = Sunday
  const offset = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + offset);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDayLabel(iso: string): { weekday: string; day: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    weekday: dt.toLocaleDateString('en-US', { weekday: 'short' }),
    day: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

function formatWeekRange(start: string, end: string): string {
  const [sy] = start.split('-').map(Number);
  const [ey] = end.split('-').map(Number);
  return sy === ey ? `${formatShort(start)} – ${formatShort(end)}, ${sy}` : `${formatShort(start)}, ${sy} – ${formatShort(end)}, ${ey}`;
}

const TICKLER_LABEL: Record<TicklerItem['staleness'], string> = {
  jot: 'Untouched jot',
  note: 'Untouched note',
  task: 'No due date',
};

function CompactTaskRow({ task, onToggle, onOpen }: { task: TodayTask; onToggle: (t: Entity) => void; onOpen: (t: Entity) => void }) {
  return (
    <div className="week-page__row" onClick={() => onOpen(task)}>
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={() => onToggle(task)}
        onClick={(e) => e.stopPropagation()}
        className="task-row__checkbox"
      />
      <span className="week-page__row-title">{task.title || 'Untitled Task'}</span>
      {task.project && <span className="task-row__project-tag" title={`In project: ${task.project.title}`}>📁 {task.project.title}</span>}
    </div>
  );
}

/** Week view — a 7-day docket, Monday first, matching a physical weekly
 * planner's spread rather than the flat single-list feel of the Day view.
 * Overdue and the stale-item Tickler are shown only on whichever column is
 * the real current day (see the /api/week comment for why); every other
 * column is just what's actually due that day, past or future. */
export function WeekPage() {
  const { start: startParam } = useParams<{ start: string }>();
  const navigate = useNavigate();
  const realToday = todayLocalISO();
  const start = startParam ?? mondayOf(realToday);

  const [data, setData] = useState<WeekResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Entity | null>(null);

  useReportTabMeta(`Week of ${formatShort(start)}`, 'today');

  const load = useCallback(() => {
    api.getWeek(start, realToday).then(setData).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  useEffect(() => {
    load();
  }, [load]);

  function goToWeek(nextStart: string) {
    navigate(nextStart === mondayOf(realToday) ? '/today/week' : `/today/week/${nextStart}`);
  }

  const containsToday = data ? data.days.some((d) => d.isToday) : start === mondayOf(realToday);
  function switchToDay() {
    navigate(containsToday ? '/today' : `/today/${start}`);
  }

  async function toggleTask(task: Entity) {
    const next = task.status === 'done' ? 'open' : 'done';
    setData((prev) =>
      prev
        ? {
            ...prev,
            overdue: prev.overdue.filter((t) => t.id !== task.id),
            days: prev.days.map((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== task.id || next !== 'done') })),
          }
        : prev
    );
    await api.updateEntity(task.id, { status: next });
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

  async function deleteTask(task: Entity) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            overdue: prev.overdue.filter((t) => t.id !== task.id),
            days: prev.days.map((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== task.id) })),
          }
        : prev
    );
    await api.deleteEntity(task.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load this week: {error}</div>;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          {data ? formatWeekRange(data.start, data.end) : formatShort(start)}
        </h1>
        <div className="today-page__nav">
          <div className="today-page__view-toggle">
            <button type="button" className="today-page__view-btn" onClick={switchToDay}>
              Day
            </button>
            <button type="button" className="today-page__view-btn is-active">
              Week
            </button>
          </div>
          {start !== mondayOf(realToday) && (
            <button type="button" className="btn btn--ghost" onClick={() => goToWeek(mondayOf(realToday))}>
              This Week
            </button>
          )}
          <button type="button" className="today-page__nav-btn" onClick={() => goToWeek(addDays(start, -7))} aria-label="Previous week" title="Previous week">
            ‹
          </button>
          <button type="button" className="today-page__nav-btn" onClick={() => goToWeek(addDays(start, 7))} aria-label="Next week" title="Next week">
            ›
          </button>
        </div>
      </div>

      {data === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="week-page__scroll">
          <div className="week-page__grid">
            {data.days.map((day) => (
              <div key={day.date} className={`week-page__col${day.isToday ? ' is-today' : ''}`}>
                <div className="week-page__col-header">
                  <span className="week-page__col-weekday">{formatDayLabel(day.date).weekday}</span>
                  <span className="week-page__col-date">{formatDayLabel(day.date).day}</span>
                </div>

                {day.isToday && data.overdue.length > 0 && (
                  <div className="week-page__special week-page__special--overdue">
                    <div className="week-page__special-title">Overdue</div>
                    {data.overdue.map((t) => (
                      <CompactTaskRow key={t.id} task={t} onToggle={toggleTask} onOpen={openTask} />
                    ))}
                  </div>
                )}

                {day.isToday && data.tickler.length > 0 && (
                  <div className="week-page__special week-page__special--tickler">
                    <div className="week-page__special-title">Worth revisiting</div>
                    {data.tickler.map((t) => (
                      <div key={t.id} className="week-page__row week-page__row--tickler" onClick={() => openTask(t)}>
                        <span className="week-page__row-title">{t.title || 'Untitled'}</span>
                        <span className="week-page__tickler-badge">{TICKLER_LABEL[t.staleness]}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="week-page__col-list">
                  {day.tasks.length === 0 ? (
                    <div className="week-page__empty">Nothing due</div>
                  ) : (
                    day.tasks.map((t) => <CompactTaskRow key={t.id} task={t} onToggle={toggleTask} onOpen={openTask} />)
                  )}
                </div>

                <Link to={day.date === realToday ? '/today' : `/today/${day.date}`} className="week-page__col-footer-link">
                  Open day →
                </Link>
              </div>
            ))}
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
