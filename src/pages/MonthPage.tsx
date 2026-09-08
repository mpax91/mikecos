import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { MeetingsRangeResponse, MonthResponse, RangeMeetingItem } from '../api/types';
import { getHolidays } from '../utils/holidays';
import { useReportTabMeta } from '../contexts/TabsContext';

// Same fixed home-timezone treatment as the Day/Week views' own meeting
// times — see TodayPage's MEETING_TZ comment.
const MEETING_TZ = 'America/New_York';
function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: MEETING_TZ, hour: 'numeric', minute: '2-digit' });
}

// A cell is only ~96px tall — beyond a few individual event lines it reads
// as clutter rather than useful detail, so the rest collapse into a "+N
// more" line, mirroring how Google Calendar's own month grid caps visible
// events per day. Click-through is still the whole cell (opens the Day
// view), so nothing shown here is actually unreachable.
const MAX_VISIBLE_MEETINGS = 3;

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

/** Compact task-count badge for a cell — spells out "N open task(s)" rather
 * than a bare icon+number, which read as too easy to miss at this size.
 * Month view is a bird's-eye look at what's coming, not a place to work the
 * backlog — click the cell to open that day's Day view, where the real list
 * and checkboxes live. */
function MonthTaskBadge({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} open task${count === 1 ? '' : 's'}`;
  return (
    <div className="month-page__task-badge" title={label}>
      <span className="month-page__task-badge-icon">☑</span> {label}
    </div>
  );
}

/** Real Google Calendar events on that day, shown as individual line items
 * (time + title) rather than rolled up into a single count the way tasks
 * are — unlike a task, a meeting has a specific time that's worth seeing at
 * a glance without opening the day, and Mike specifically wanted these to
 * read differently from the task badge below them. Caps at
 * MAX_VISIBLE_MEETINGS with a "+N more" line for the rest. */
function MonthMeetingList({ meetings }: { meetings: RangeMeetingItem[] }) {
  if (meetings.length === 0) return null;
  const visible = meetings.slice(0, MAX_VISIBLE_MEETINGS);
  const overflow = meetings.length - visible.length;
  return (
    <div className="month-page__meeting-list">
      {visible.map((m) => (
        <div key={m.id} className="month-page__meeting-item" title={`${m.allDay ? 'All day' : formatMeetingTime(m.start)} · ${m.title}`}>
          {!m.allDay && <span className="month-page__meeting-item-time">{formatMeetingTime(m.start)}</span>}
          <span className="month-page__meeting-item-title">{m.title}</span>
        </div>
      ))}
      {overflow > 0 && <div className="month-page__meeting-more">+{overflow} more</div>}
    </div>
  );
}

/** Month view — a Google-Calendar-style grid: every day of the visible
 * month (plus the previous/next month's spillover days needed to fill a
 * whole 7-column grid), each cell showing that day's holiday (if any) and
 * a compact count of tasks due that day. It's a bird's-eye look at what's
 * coming, not a place to work the backlog — no Overdue, Tickler, or
 * Unscheduled shelf here, and no blank ruled lines to fill in; those all
 * stay on Day/Week. Clicking anywhere in a cell opens that day's Day view,
 * where the real list and checkboxes live. */
export function MonthPage() {
  const { month: monthParam } = useParams<{ month: string }>();
  const navigate = useNavigate();
  const realToday = todayLocalISO();
  const month = monthParam ?? monthOf(realToday);

  const [data, setData] = useState<MonthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meetingsData, setMeetingsData] = useState<MeetingsRangeResponse | null>(null);

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

  // Real Google Calendar events for the whole visible grid, same "nice-to-
  // have overlay" treatment as the Day view's meetings fetch — a failed or
  // unconfigured fetch just means no meeting badges rather than blocking
  // the rest of the page.
  useEffect(() => {
    api
      .getMeetingsRange(gridStart, gridEnd)
      .then(setMeetingsData)
      .catch(() => setMeetingsData(null));
  }, [gridStart, gridEnd]);

  const taskCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    if (!data) return map;
    for (const t of data.tasks) {
      map.set(t.due_date!, (map.get(t.due_date!) ?? 0) + 1);
    }
    return map;
  }, [data]);

  const meetingsByDate = useMemo(() => {
    const map = new Map<string, RangeMeetingItem[]>();
    if (!meetingsData) return map;
    for (const m of meetingsData.meetings) {
      const list = map.get(m.date);
      if (list) list.push(m);
      else map.set(m.date, [m]);
    }
    return map;
  }, [meetingsData]);

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
              const isPast = date < realToday;
              const holidays = getHolidays(date);
              const taskCount = taskCountByDate.get(date) ?? 0;
              const dayMeetings = meetingsByDate.get(date) ?? [];

              return (
                <div
                  key={date}
                  className={`month-page__cell${inMonth ? '' : ' is-outside-month'}${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}`}
                  onClick={() => openDay(date)}
                >
                  <div className="month-page__cell-header">
                    <span className={`month-page__cell-date${isToday ? ' is-today' : ''}`}>{formatDayNum(date)}</span>
                  </div>
                  {holidays.length > 0 && <div className="month-page__cell-holiday">{holidays.join(' · ')}</div>}
                  <MonthMeetingList meetings={dayMeetings} />
                  <MonthTaskBadge count={taskCount} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
