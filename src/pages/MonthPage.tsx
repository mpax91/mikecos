import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { MeetingsRangeResponse, MonthResponse, RangeMeetingItem } from '../api/types';
import { getHolidays } from '../utils/holidays';
import { fmtBillMoney } from '../utils/bills';
import { useReportTabMeta } from '../contexts/TabsContext';
import { buildMeetingNoteTitle, meetingHasEnded } from '../utils/meetingNotes';

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

/** Groups a flat, already-date-sorted UpcomingItem[] into per-date buckets,
 * preserving order — the Upcoming list's rows share one date header per day
 * rather than repeating the date on every single row. */
function groupUpcomingByDate(items: UpcomingItem[]): { date: string; items: UpcomingItem[] }[] {
  const groups: { date: string; items: UpcomingItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

/** "Today" / "Tomorrow" / "Fri, Sep 25" — matches the reference Android
 * widget's date-first list, with the same today/tomorrow shorthand most
 * calendar list views use instead of spelling out a date someone would have
 * to do the arithmetic on themselves. */
function formatUpcomingDateHeader(date: string, realToday: string): string {
  if (date === realToday) return 'Today';
  if (date === addDays(realToday, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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

/** One row in the Upcoming table below the grid — a calendar event reduced
 * to {date, time, label}. `time` is null for an all-day event, which shows
 * "All Day" and sorts ahead of that day's timed events. */
interface UpcomingItem {
  key: string;
  date: string;
  time: string | null; // pre-formatted, e.g. "11:00 AM" — null means date-only
  sortTime: number; // minutes since midnight for same-day ordering; timed entries first
  label: string;
  meeting: RangeMeetingItem;
  onClick: () => void;
}

const MAX_UPCOMING_ITEMS = 20;

/** Real Google Calendar events on that day, shown as individual line items
 * (time + title) rather than rolled up into a single count the way tasks
 * are — unlike a task, a meeting has a specific time that's worth seeing at
 * a glance without opening the day, and Mike specifically wanted these to
 * read differently from the task badge below them. Caps at
 * MAX_VISIBLE_MEETINGS with a "+N more" line for the rest. */
function MonthMeetingList({ meetings, cellDate, realToday }: { meetings: RangeMeetingItem[]; cellDate: string; realToday: string }) {
  if (meetings.length === 0) return null;
  const visible = meetings.slice(0, MAX_VISIBLE_MEETINGS);
  const overflow = meetings.length - visible.length;
  const now = Date.now();
  return (
    <div className="month-page__meeting-list">
      {visible.map((m) => {
        // Same "is this actually over" rule as the Week view: a timed
        // meeting once its end instant has passed, an all-day one once its
        // whole local day has (cellDate is that day, already known by the
        // caller — no per-item date math needed).
        const isPast = m.allDay ? cellDate < realToday : new Date(m.end).getTime() < now;
        return (
          <div
            key={m.id}
            className={`month-page__meeting-item${isPast ? ' month-page__meeting-item--past' : ''}`}
            title={`${m.allDay ? 'All day' : formatMeetingTime(m.start)} · ${m.title}`}
          >
            {!m.allDay && <span className="month-page__meeting-item-time">{formatMeetingTime(m.start)}</span>}
            <span className="month-page__meeting-item-title">{m.title}</span>
          </div>
        );
      })}
      {overflow > 0 && <div className="month-page__meeting-more">+{overflow} more</div>}
    </div>
  );
}

/** The scrollable list below the month grid — every calendar event from
 * today forward in this page's visible range, chronological across day
 * boundaries. Events only (Mike, 2026-10-09): tasks already show as the
 * per-cell "N open tasks" badge and live on Day/Week, so listing them here
 * buried the actual meetings. Laid out as a ruled Date / Time / Event table
 * so the rows are easy to scan — the date shows once per day, with a
 * heavier rule where a new day starts. */
function UpcomingList({
  items,
  realToday,
  onOpenNote,
}: {
  items: UpcomingItem[];
  realToday: string;
  onOpenNote: (m: RangeMeetingItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="month-page__upcoming">
      <div className="month-page__upcoming-title">Upcoming</div>
      <div className="month-page__upcoming-list">
        <table className="month-page__upcoming-table">
          <thead>
            <tr>
              <th className="month-page__upcoming-date">Date</th>
              <th className="month-page__upcoming-time">Time</th>
              <th>Event</th>
              <th className="month-page__upcoming-actions" aria-label="Links" />
            </tr>
          </thead>
          {groupUpcomingByDate(items).map((group) => (
            <tbody key={group.date} className="month-page__upcoming-group">
              {group.items.map((item, i) => (
                <tr key={item.key} className="month-page__upcoming-row" onClick={item.onClick}>
                  <td className="month-page__upcoming-date">
                    {i === 0 ? formatUpcomingDateHeader(group.date, realToday) : ''}
                  </td>
                  <td className="month-page__upcoming-time">{item.time ?? 'All Day'}</td>
                  <td className="month-page__upcoming-label" title={item.label}>{item.label}</td>
                  <td className="month-page__upcoming-actions" onClick={(e) => e.stopPropagation()}>
                    <UpcomingLinks m={item.meeting} onOpenNote={onOpenNote} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

/** The same two links a meeting row has on the Day view — 📅 opens the
 * event in Google Calendar, 📝 opens its note (or creates one for an event
 * that hasn't ended yet). Same classes and rules as TodayPage. */
function UpcomingLinks({ m, onOpenNote }: { m: RangeMeetingItem; onOpenNote: (m: RangeMeetingItem) => void }) {
  const noteDisabled = !m.hasNote && meetingHasEnded(m);
  return (
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
        title={m.hasNote ? 'Open Note' : noteDisabled ? 'No Note for This Meeting' : 'Create Note'}
        aria-disabled={noteDisabled}
        onClick={() => {
          if (!noteDisabled) onOpenNote(m);
        }}
      >
        📝
      </button>
    </span>
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
  const loadMeetings = useCallback(() => {
    api
      .getMeetingsRange(gridStart, gridEnd)
      .then(setMeetingsData)
      .catch(() => setMeetingsData(null));
  }, [gridStart, gridEnd]);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  // The Upcoming table's 📝 link — same behavior as TodayPage's
  // openMeetingNote: open the linked note, else (only for an event that
  // hasn't ended) create one titled from the event and open it.
  async function openMeetingNote(m: RangeMeetingItem) {
    if (m.hasNote) {
      const { noteEntityId } = await api.getMeetingNote(m.id);
      if (noteEntityId) {
        navigate(`/notes/${noteEntityId}`);
        return;
      }
      loadMeetings(); // stale hasNote — the worker dropped the dangling link
    }
    if (meetingHasEnded(m)) return;
    const { noteEntityId } = await api.createMeetingNote(m.id, buildMeetingNoteTitle(m));
    navigate(`/notes/${noteEntityId}`);
  }

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

  // The Upcoming list below the grid (calendar events only — no tasks) —
  // Mike's reference was an Android
  // calendar widget that lists what's ahead chronologically regardless of
  // which day it falls on, rather than requiring a scan across grid cells.
  // Built from the same data.tasks / meetingsData already fetched for the
  // grid cells themselves — no separate request. Scoped to this page's own
  // visible range (gridStart..gridEnd) and only dates from today forward:
  // on the current month that's "the rest of this month plus a few padding
  // days into next," and on a future month it naturally becomes "everything
  // in it" since every date there is still ahead; a fully past month just
  // renders an empty list; the click-through matches every other item on
  // this page in opening that day's Day view.
  const upcomingItems = useMemo<UpcomingItem[]>(() => {
    const items: UpcomingItem[] = [];
    if (meetingsData) {
      for (const m of meetingsData.meetings) {
        if (m.date < realToday) continue;
        items.push({
          key: `meeting:${m.id}`,
          date: m.date,
          time: m.allDay ? null : formatMeetingTime(m.start),
          sortTime: m.allDay ? -1 : new Date(m.start).getHours() * 60 + new Date(m.start).getMinutes(),
          label: m.title,
          meeting: m,
          onClick: () => openDay(m.date),
        });
      }
    }
    items.sort((a, b) => (a.date === b.date ? a.sortTime - b.sortTime : a.date < b.date ? -1 : 1));
    return items.slice(0, MAX_UPCOMING_ITEMS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingsData, realToday]);

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
                  {(data.autopayBills ?? [])
                    .filter((b) => b.date === date)
                    .map((b) => (
                      <div key={b.billId} className="month-page__cell-autopay" title={`On Auto-Pay${b.amount != null ? ` · ${fmtBillMoney(b.amount)}` : ''} — nothing to do`}>
                        Auto-Pay · {b.name}
                      </div>
                    ))}
                  <MonthMeetingList meetings={dayMeetings} cellDate={date} realToday={realToday} />
                  <MonthTaskBadge count={taskCount} />
                </div>
              );
            })}
          </div>
          <UpcomingList items={upcomingItems} realToday={realToday} onOpenNote={openMeetingNote} />
        </div>
      )}
    </div>
  );
}
