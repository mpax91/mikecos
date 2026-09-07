import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { api } from '../api/client';
import type { Entity, TodayTask, WeatherDay, WeekResponse } from '../api/types';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { BlankLine } from '../components/BlankLine';
import { WeatherWidget } from '../components/WeatherWidget';
import { getHolidays } from '../utils/holidays';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Blank ruled lines shown below each day's real tasks — see BlankLine. */
const BLANK_LINES_PER_DAY = 10;

/** Droppable id prefix for a day column, so handleDragEnd can tell a day
 * target apart from the 'unscheduled' shelf without a lookup table. */
const DAY_DROP_PREFIX = 'day:';
const UNSCHEDULED_DROP_ID = 'unscheduled';

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

/** A task row that can be picked up and dragged onto a day column or the
 * Unscheduled shelf to reschedule it — used for every real task shown on
 * this page (Overdue, a day's tasks, and the Unscheduled shelf itself). */
function DraggableTaskRow({ task, onToggle, onOpen }: { task: TodayTask; onToggle: (t: Entity) => void; onOpen: (t: Entity) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`week-page__row${isDragging ? ' is-dragging' : ''}`}
      onClick={() => onOpen(task)}
    >
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={() => onToggle(task)}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="task-row__checkbox"
      />
      <span className="week-page__row-title">{task.title || 'Untitled Task'}</span>
      {task.project && <span className="task-row__project-tag" title={`In project: ${task.project.title}`}>📁 {task.project.title}</span>}
    </div>
  );
}

/** One day column — a drop target for rescheduling, holding its real tasks
 * followed by a fixed run of blank ruled lines to write new ones into. */
function DayColumn({
  day,
  data,
  weather,
  onToggle,
  onOpen,
  onQuickAdd,
}: {
  day: WeekResponse['days'][number];
  data: WeekResponse;
  weather: WeatherDay | undefined;
  onToggle: (t: Entity) => void;
  onOpen: (t: Entity) => void;
  onQuickAdd: (date: string, title: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DAY_DROP_PREFIX}${day.date}` });
  const realToday = todayLocalISO();
  const holidays = getHolidays(day.date);

  return (
    <div
      ref={setNodeRef}
      className={`week-page__col${day.isToday ? ' is-today' : ''}${isOver ? ' is-drop-target' : ''}`}
    >
      <div className="week-page__col-header">
        <div className="week-page__col-header-top">
          <span className="week-page__col-weekday">{formatDayLabel(day.date).weekday}</span>
          <span className="week-page__col-date">{formatDayLabel(day.date).day}</span>
          <WeatherWidget day={weather} variant="chip" />
        </div>
        {/* Always rendered, even with nothing to say — a holiday name on
            one column and nothing on the rest used to leave that column's
            header taller than its neighbors, throwing the whole row out of
            alignment. A reserved, empty line keeps every column's header
            the same height whether or not that day has an observance. */}
        <div className="week-page__col-holiday">{holidays.length > 0 ? holidays.join(' · ') : ' '}</div>
      </div>

      {day.isToday && data.overdue.length > 0 && (
        <div className="week-page__special week-page__special--overdue">
          <div className="week-page__special-title">Overdue</div>
          {data.overdue.map((t) => (
            <DraggableTaskRow key={t.id} task={t} onToggle={onToggle} onOpen={onOpen} />
          ))}
        </div>
      )}

      <div className="week-page__col-list">
        {day.tasks.map((t) => (
          <DraggableTaskRow key={t.id} task={t} onToggle={onToggle} onOpen={onOpen} />
        ))}
        {Array.from({ length: BLANK_LINES_PER_DAY }).map((_, i) => (
          <BlankLine key={i} onSubmit={(title) => onQuickAdd(day.date, title)} />
        ))}
      </div>

      <Link to={day.date === realToday ? '/today' : `/today/${day.date}`} className="week-page__col-footer-link">
        Open Day →
      </Link>
    </div>
  );
}

/** The shelf of every undated open task, below the week grid — also a drop
 * target, so dragging a scheduled task here clears its due date. */
function UnscheduledShelf({ tasks, onToggle, onOpen }: { tasks: TodayTask[]; onToggle: (t: Entity) => void; onOpen: (t: Entity) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED_DROP_ID });
  return (
    <div ref={setNodeRef} className={`week-page__unscheduled${isOver ? ' is-drop-target' : ''}`}>
      <div className="week-page__unscheduled-header">
        <span className="week-page__unscheduled-title">Unscheduled</span>
        <span className="week-page__unscheduled-hint">Drag onto a day to schedule it</span>
      </div>
      {tasks.length === 0 ? (
        <div className="week-page__empty">Nothing waiting — nice.</div>
      ) : (
        // A vertical stack of full-width rows rather than wrapped chips —
        // chips were clipping longer titles at a fixed width. A row has the
        // full shelf width to work with, so a title only truncates if it's
        // genuinely too long for the whole page.
        <div className="week-page__unscheduled-list">
          {tasks.map((t) => (
            <UnscheduledRow key={t.id} task={t} onToggle={onToggle} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnscheduledRow({ task, onToggle, onOpen }: { task: TodayTask; onToggle: (t: Entity) => void; onOpen: (t: Entity) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`week-page__unscheduled-row${isDragging ? ' is-dragging' : ''}`}
      onClick={() => onOpen(task)}
    >
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={() => onToggle(task)}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="task-row__checkbox"
      />
      <span className="week-page__row-title">{task.title || 'Untitled Task'}</span>
      {task.project && <span className="task-row__project-tag" title={`In project: ${task.project.title}`}>📁 {task.project.title}</span>}
    </div>
  );
}

/** Week view — a 7-day docket, Monday first, matching a physical weekly
 * planner's spread rather than the flat single-list feel of the Day view.
 * Overdue is shown only on whichever column is the real current day (see
 * the /api/week comment for why); every other column is just what's
 * actually due that day, past or future. The stale-item Tickler now shows
 * only on the Day view, not repeated here. Below the grid, the Unscheduled
 * shelf surfaces every undated open task so nothing quietly falls out of
 * view, and every task on the page can be dragged between days or onto/off
 * the shelf to reschedule it. */
export function WeekPage() {
  const { start: startParam } = useParams<{ start: string }>();
  const navigate = useNavigate();
  const realToday = todayLocalISO();
  const start = startParam ?? mondayOf(realToday);

  const [data, setData] = useState<WeekResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [weatherByDate, setWeatherByDate] = useState<Map<string, WeatherDay>>(new Map());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useReportTabMeta(`Week of ${formatShort(start)}`, 'today');

  const load = useCallback(() => {
    api.getWeek(start, realToday).then(setData).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  useEffect(() => {
    load();
  }, [load]);

  // Fetched once — the same ~16-day forecast covers every week the user
  // might page through near the present, and a day outside that window
  // just renders no weather widget (see WeatherWidget). Failure is silent:
  // weather is a nice-to-have overlay, never something that should block
  // or error out the planner itself.
  useEffect(() => {
    api
      .getWeather()
      .then((res) => setWeatherByDate(new Map(res.days.map((d) => [d.date, d]))))
      .catch(() => {});
  }, []);

  function goToWeek(nextStart: string) {
    navigate(nextStart === mondayOf(realToday) ? '/today/week' : `/today/week/${nextStart}`);
  }

  const containsToday = data ? data.days.some((d) => d.isToday) : start === mondayOf(realToday);
  function switchToDay() {
    navigate(containsToday ? '/today' : `/today/${start}`);
  }

  // Every draggable task on the page, keyed by id, so the DragOverlay and
  // handleDragEnd can look one up by the id dnd-kit hands back without
  // caring which bucket (overdue / a day / unscheduled) it came from.
  const allTasksById = useMemo(() => {
    const map = new Map<string, TodayTask>();
    if (!data) return map;
    for (const t of data.overdue) map.set(t.id, t);
    for (const day of data.days) for (const t of day.tasks) map.set(t.id, t);
    for (const t of data.unscheduled) map.set(t.id, t);
    return map;
  }, [data]);

  async function toggleTask(task: Entity) {
    const next = task.status === 'done' ? 'open' : 'done';
    setData((prev) =>
      prev
        ? {
            ...prev,
            overdue: prev.overdue.filter((t) => t.id !== task.id),
            days: prev.days.map((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== task.id || next !== 'done') })),
            unscheduled: prev.unscheduled.filter((t) => t.id !== task.id || next !== 'done'),
          }
        : prev
    );
    await api.updateEntity(task.id, { status: next });
    load();
  }

  async function quickAdd(date: string, title: string) {
    await api.createStandaloneTask(title, date);
    load();
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const taskId = String(active.id);
    const overId = String(over.id);
    const nextDueDate = overId === UNSCHEDULED_DROP_ID ? null : overId.startsWith(DAY_DROP_PREFIX) ? overId.slice(DAY_DROP_PREFIX.length) : undefined;
    if (nextDueDate === undefined) return;
    const task = allTasksById.get(taskId);
    if (!task || task.due_date === nextDueDate) return;
    await api.updateEntity(taskId, { due_date: nextDueDate });
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
            unscheduled: prev.unscheduled.filter((t) => t.id !== task.id),
          }
        : prev
    );
    await api.deleteEntity(task.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load this week: {error}</div>;

  const activeDragTask = activeDragId ? allTasksById.get(activeDragId) : null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
          <>
            <div className="week-page__scroll">
              <div className="week-page__grid">
                {data.days.map((day) => (
                  <DayColumn
                    key={day.date}
                    day={day}
                    data={data}
                    weather={weatherByDate.get(day.date)}
                    onToggle={toggleTask}
                    onOpen={openTask}
                    onQuickAdd={quickAdd}
                  />
                ))}
              </div>
            </div>

            <UnscheduledShelf tasks={data.unscheduled} onToggle={toggleTask} onOpen={openTask} />
          </>
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

      <DragOverlay>
        {activeDragTask && (
          <div className="week-page__drag-overlay">
            <span className="week-page__row-title">{activeDragTask.title || 'Untitled Task'}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
