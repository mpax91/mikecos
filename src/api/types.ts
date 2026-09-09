export type EntityType = 'project' | 'folder' | 'note' | 'task' | 'file' | 'link';

export interface FileMeta {
  r2_key: string;
  mime_type: string;
  size: number;
  filename: string;
}

export interface LinkMeta {
  url: string;
  /** Server-fetched rich preview (og:title/og:image + domain) for a link
   * inserted via the editor's "Insert link preview" button. Absent for a
   * plain inline hyperlink, or when the target page couldn't be unfurled. */
  preview_title?: string | null;
  preview_image?: string | null;
  preview_domain?: string | null;
}

/** Tasks store their extra detail (everything beyond title/status/due date)
 * as JSON in the shared `content` column — same pattern notes and files use
 * it for, just a different shape. Due date used to live here too, but it's
 * now a real column on Entity (see migrations/0006_planner.sql) so the
 * daily planner can query "everything due today" without parsing every
 * task's JSON. */
export interface TaskMeta {
  description?: string;
}

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  content: string | null;
  parent_id: string | null;
  is_top_level: number;
  status: string | null;
  position: number;
  pinned: number;
  /** A Jot is stored as type='note' with this flag set, not a distinct type. */
  is_jot: number;
  /** 'YYYY-MM-DD', tasks only. Powers the Today page's Overdue/Today split. */
  due_date: string | null;
  /** 'HH:MM' 24-hour, tasks only, meaningless without due_date — an
   * optional time of day layered on top of the due date (e.g. "2:00 PM"),
   * cleared automatically whenever due_date itself is cleared. */
  due_time: string | null;
  /** Manual order among tasks sharing the same due_date — the Day view's
   * promote/demote, independent of `position` (which orders a task within
   * its own project). NULL for anything never explicitly reordered this
   * way, sorting after any real value. */
  due_position: number | null;
  last_touched: string | null;
  created_at: string;
  updated_at: string;
  /** Only present on task entities returned as children of another entity —
   * one level of the task's own child tasks, attached by the API so the
   * project view can render subtasks nested under their parent. */
  subtasks?: Entity[];
  /** Same idea as `subtasks`, for the task's own file/link attachments —
   * lets the project view show a small attachment indicator without a
   * separate fetch per task. */
  media?: Entity[];
  /** True when this task is the live instance of an active recurring task
   * definition (see Settings' Recurring Tasks panel) — only populated by
   * GET /api/today today. Drives the "Recurring" badge in place of the
   * usual last-modified text, and floats the task to the top of the Day
   * view's list. */
  is_recurring?: boolean;
}

export interface ProjectListItem extends Entity {
  child_count: number;
  pinned_count: number;
  folder_count: number;
  note_count: number;
  media_count: number;
  open_task_count: number;
  open_subtask_count: number;
}

export interface EntityDetail {
  entity: Entity;
  breadcrumb: Entity[];
  children: Entity[];
}

/** A task as returned by GET /api/today — the same Entity, plus its
 * resolved top-level project (null for a standalone task with no project),
 * used for the little project tag next to it on the daily planner. */
export interface TodayTask extends Entity {
  project: { id: string; title: string } | null;
}

export interface TodayResponse {
  date: string;
  overdue: TodayTask[];
  today: TodayTask[];
  /** The stale-item Tickler ("Worth revisiting") — used to be repeated
   * across every Week column, now shows just once here on the Day view. */
  tickler: TicklerItem[];
}

/** One stale item surfaced by the Tickler — the entity itself plus which
 * bucket it was picked from (jot / note), used to pick the right icon and
 * "why this is here" phrasing. Undated tasks used to have their own
 * staleness bucket here too, but now that the Week view's Unscheduled shelf
 * shows every undated task (not just the single oldest), that entry would
 * just be a duplicate of the shelf's own top row — dropped in favor of it. */
export interface TicklerItem extends Entity {
  staleness: 'jot' | 'note';
}

export interface WeekDay {
  date: string;
  isToday: boolean;
  tasks: TodayTask[];
  /** Tasks checked off on this day (bucketed by task_completions'
   * completed_date, not due_date) — only populated for days before the
   * viewer's real "today" (see the worker's /api/week comment). Rendered
   * with a strikethrough as a record of what got done, not an editable
   * list. */
  completed: CompletionItem[];
}

/** One day's forecast from GET /api/weather — the worker's already reduced
 * Open-Meteo's response down to just what the UI shows, so nothing here
 * needs further interpretation client-side beyond picking a unit label. */
export interface WeatherDay {
  date: string;
  icon: string;
  summary: string;
  tempMaxF: number;
  tempMinF: number;
  precipProbability: number;
  windMaxMph: number;
}

export interface WeatherResponse {
  location: string;
  days: WeatherDay[];
}

export interface WeekResponse {
  start: string;
  end: string;
  days: WeekDay[];
  overdue: TodayTask[];
  /** Every open task with no due date at all, oldest-touched first — shown
   * below the week grid so nothing undated gets forgotten, and draggable
   * onto a day column to schedule it. */
  unscheduled: TodayTask[];
}

/** GET /api/month — a flat list of every open task due somewhere in the
 * visible grid ([start, end], which spans the padding days from the
 * previous/next month too); MonthPage buckets these by due_date itself
 * rather than the server pre-grouping them into a fixed day list the way
 * /api/week does. */
export interface MonthResponse {
  start: string;
  end: string;
  tasks: TodayTask[];
}

/** One real Google Calendar event (not a MikeOS task) from GET
 * /api/meetings — `start`/`end` are ISO instants (already resolved to UTC
 * server-side, whatever timezone the source ICS used), and `gcalUrl` is a
 * best-effort direct link to the event on calendar.google.com (see the
 * worker's ics.ts for how — it's a reverse-engineered, undocumented format,
 * so treat a dead link as a possible outcome, not a bug). */
export interface MeetingItem {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  gcalUrl: string | null;
}

export interface MeetingsResponse {
  date: string;
  meetings: MeetingItem[];
}

/** A meeting occurrence from GET /api/meetings/range — the Week/Month
 * views' bulk fetch of everything in their visible span, each occurrence
 * tagged with its own local `date` so the caller can bucket it by day the
 * same way MonthResponse's tasks are bucketed by due_date. */
export interface RangeMeetingItem extends MeetingItem {
  date: string;
}

export interface MeetingsRangeResponse {
  start: string;
  end: string;
  meetings: RangeMeetingItem[];
}

/** Completed-task rollups from GET /api/stats — see the worker's comment
 * there for how `week`/`month`/`year` are bucketed and why the counts
 * come from a dedicated completion log rather than the live entities
 * table. `trend` is the last 14 local days, oldest first, zero-filled. */
export interface StatsResponse {
  date: string;
  today: number;
  week: number;
  month: number;
  year: number;
  trend: { date: string; count: number }[];
}

/** One row of the completion log itself, from GET /api/stats/completions —
 * the Stats page's "when did I do X" list. `title` is a snapshot from the
 * moment the task was checked off, independent of whatever's happened to
 * the task (or the task itself) since. */
export interface CompletionItem {
  id: string;
  entity_id: string;
  title: string;
  completed_at: string;
  completed_date: string;
}

export interface CompletionsResponse {
  completions: CompletionItem[];
  has_more: boolean;
}

/** One Google Calendar feed, managed self-service on the Settings screen's
 * Calendar Integrations panel (see migrations/0008_calendar_feeds.sql) —
 * `urlPreview` is a masked stand-in for the real secret address, which the
 * list/detail responses never echo back in full; only creating or editing
 * a feed sends the real URL, and only in that one direction. `ok`/`error`/
 * `eventCountToday` come from a live fetch+parse done at request time, not
 * a cached value, so a broken feed shows exactly why. */
export interface CalendarFeedStatus {
  id: string;
  label: string;
  urlPreview: string;
  active: boolean;
  ok: boolean;
  error: string | null;
  eventCountToday: number;
}

export interface CalendarFeedsResponse {
  today: string;
  calendars: CalendarFeedStatus[];
}

// ---- Canvas boards (infinite-canvas pinboard) ----

// 'connector' is a freestanding line/arrow object placed via the toolbar
// (+ Arrow / + Divider) — just another item, not a relationship stored
// between two other items. See ConnectorItemContent below.
export type CanvasItemType = 'image' | 'text' | 'note' | 'connector';

export interface CanvasBoard {
  id: string;
  title: string;
  pinned: number; // 0 | 1 — pin-to-top on the boards list, same as Entity.pinned for Projects
  created_at: string;
  updated_at: string;
}

/** A board as returned by the boards list — adds a live item count for the
 * card, computed server-side rather than stored. */
export interface CanvasBoardListItem extends CanvasBoard {
  item_count: number;
}

export interface ImageItemContent {
  r2_key: string;
  mime_type: string;
  filename: string;
}

export interface TextItemContent {
  text: string;
}

export interface NoteItemContent {
  text: string;
  color: string;
}

/** A freestanding line or arrow. Each endpoint is EITHER attached to
 * another item (by id — its live position is recomputed from that item's
 * current box every render, so the line "follows" a dragged card
 * automatically) OR freestanding (an explicit world-space point, stored
 * here, that only moves when you drag that endpoint yourself). Nothing
 * requires an endpoint to be attached at all — "arrows on their own" was
 * the point, not every card needing to originate one. */
export interface ConnectorItemContent {
  style: 'arrow' | 'line';
  fromItemId: string | null;
  x1: number;
  y1: number;
  toItemId: string | null;
  x2: number;
  y2: number;
}

/** One free-floating item on a board — x/y/width/height are board-space
 * pixels at 1:1 zoom (unbounded, can be negative), not screen pixels; the
 * canvas applies its own pan/zoom transform on top. `content` is a raw JSON
 * string, same as Entity.content elsewhere in this app — parse it per
 * `type` (see ImageItemContent/TextItemContent/NoteItemContent/
 * ConnectorItemContent) at the point of use rather than eagerly, since the
 * union isn't discriminated at the type level. `title` is a small optional
 * caption shown above the item — organizational only, never required. */
export interface CanvasItem {
  id: string;
  board_id: string;
  type: CanvasItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  content: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/** Deprecated: the old item-to-item "drag from a card's edge handle"
 * connector model. No longer created or read by the UI (see
 * ConnectorItemContent for what replaced it — a freestanding item type)
 * but the type and its API/table are left in place rather than ripped
 * out, since removing a D1 table is never safe to do casually. */
export interface CanvasConnector {
  id: string;
  board_id: string;
  from_item_id: string;
  to_item_id: string;
  created_at: string;
}

export interface CanvasBoardDetail {
  board: CanvasBoard;
  items: CanvasItem[];
  connectors: CanvasConnector[];
}

// ---- Shelf (self-clearing drop zone on the Jots page) ----

export type ShelfItemType = 'text' | 'image' | 'link' | 'file';

export interface ShelfTextContent {
  text: string;
}

/** Shape returned by GET /api/link-preview (and what a shelf link item
 * stores as-is) — deliberately not FileMeta's/LinkMeta's `preview_`-
 * prefixed field names, which are Entity's own link-attachment storage
 * convention; this is the plain unfurl-result shape instead. */
export interface ShelfLinkContent {
  url: string;
  title: string | null;
  domain: string | null;
  image: string | null;
}

/** A parked item on the Shelf — text/link content is JSON per the types
 * above; image/file content reuses FileMeta (the exact shape
 * api.uploadInline already returns), since a shelf image/file is nothing
 * more than an unfiled upload. No title, no rich body: the whole point of
 * the Shelf is a lighter, more disposable unit than a Jot. */
export interface ShelfItem {
  id: string;
  type: ShelfItemType;
  content: string;
  pinned: number; // 0 | 1 — exempt from the auto-clear sweep
  created_at: string;
}

/** A recurring task definition managed on the Settings screen — describes
 * the repeating chore itself (title, project, RRULE, anchor date); the
 * actual task instances that show up on Today/Week/Month are ordinary
 * Entities the worker spawns lazily (see the worker's spawnDueRecurringTasks
 * comment on GET /api/today). `current_task_id` is the live outstanding
 * spawned instance (null if none has spawned, or the last one is done). */
export interface RecurringTaskDefinition {
  id: string;
  title: string;
  project_id: string | null;
  project_title: string | null;
  rrule: string;
  dtstart: string;
  active: number; // 0 | 1
  current_task_id: string | null;
  last_spawned_due_date: string | null;
  created_at: string;
  updated_at: string;
}
