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
