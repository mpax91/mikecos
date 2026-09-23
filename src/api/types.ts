export type EntityType = 'project' | 'folder' | 'note' | 'task' | 'file' | 'link' | 'vault_entry';

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
  /** A List is stored as type='project' with this flag set, not a distinct
   * type (see migrations/0029_lists.sql) — its items are ordinary type='task'
   * children, same as a project's tasks. */
  is_list: number;
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

/** A List's card on the Lists index page — see migrations/0029_lists.sql.
 * Deliberately simpler than ProjectListItem (no folder/note/media split,
 * since a List never has those kinds of children in practice). */
export interface ListItem extends Entity {
  open_count: number;
  done_count: number;
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
  /** The "Worth Revisiting" daily spotlight — one open, unscheduled task
   * (no due date at all, same backlog as Week view's Unscheduled shelf),
   * deterministically rotating one-per-calendar-day rather than always the
   * same item, as a nudge to do it or actually give it a due date. Null
   * when there's no unscheduled backlog to draw from. */
  spotlight: TodayTask | null;
  /** Contacts whose birthday/anniversary falls on this exact date
   * (month+day match; year is optional and irrelevant to the match). */
  birthdays: ImportantDateContact[];
  anniversaries: ImportantDateContact[];
  /** Tasks actually checked off on the viewed day (task_completions'
   * completed_date) — only populated when the viewed date is strictly
   * before the viewer's real "today" (see the worker's /api/today
   * comment). Rendered with a strikethrough as a record of what got done
   * that day, same convention as WeekDay.completed below. */
  completed: CompletionItem[];
}

/** One headline in the Today page's "Top Stories" block (GET /api/top-news)
 * — server-cached on a TTL, refreshed independently of whichever date is
 * being viewed. `preview`/`imageUrl` can be null if the source didn't have
 * one for that story; the row falls back to a plain placeholder tile and
 * skips the preview line rather than leaving a broken image. */
export interface TopNewsItem {
  headline: string;
  url: string;
  source: string;
  preview: string | null;
  imageUrl: string | null;
}

export interface TopNewsResponse {
  items: TopNewsItem[];
}

/** A contact surfaced in the Today page's Important Dates panel — just
 * enough to render and link to the full contact, not the whole Contact
 * record. */
export interface ImportantDateContact {
  id: string;
  name: string;
  birthday_year?: number | null;
  anniversary_year?: number | null;
  /** 'manual' | 'google_import' | 'contact_import' | 'voter_file' — used to
   * flag voter-roll-sourced dates with the same 🗳️ marker ContactsListPage
   * uses, rather than showing them indistinguishably from real contacts. */
  source: string;
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
export interface MeetingAttendee {
  name: string | null;
  email: string;
}

export interface MeetingItem {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  gcalUrl: string | null;
  /** Whether a meeting note already exists for this exact occurrence (see
   * GET/PUT/DELETE /api/meetings/:meetingId/note) — server computed via a
   * batched lookup so the note icon can show filled-vs-outline without a
   * per-meeting fetch. */
  hasNote: boolean;
  /** Who's on the invite (from the ICS ATTENDEE lines) — empty when the
   * source feed doesn't expose attendees. */
  attendees: MeetingAttendee[];
  location: string | null;
  /** Links pulled out of the invite description (Meet link, a pasted Doc
   * URL, etc.) — see worker/src/ics.ts's ParsedMeeting.links comment. */
  links: string[];
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

/** One tile on the sidebar "Links" page (see migrations/0028_quick_links.sql)
 * — a self-service quick jump to something that otherwise gets buried
 * inside its own app (a Claude Project, a ChatGPT GPT, the Cal.com booking
 * link). `type: 'copy'` tiles copy `url` to the clipboard on click instead
 * of opening it. `thumbnailUrl`, when present, is a manually-uploaded
 * square image (via POST /api/upload) that takes priority over `icon`, a
 * plain emoji fallback. `category` groups tiles on the Links page, in
 * `sortOrder` order. */
export interface QuickLink {
  id: string;
  name: string;
  url: string;
  type: 'open' | 'copy';
  icon: string | null;
  thumbnailUrl: string | null;
  category: string;
  sortOrder: number;
}

export interface QuickLinksResponse {
  links: QuickLink[];
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
  pinned: number; // 0 | 1 — pin-to-top, same as other Shelf item ordering
  created_at: string;
}

// ---- Contacts (personal CRM) ----

export type ContactCircle = 'family' | 'friends' | 'neighbors' | 'community' | 'professional' | 'other';

export interface Contact {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  circle: ContactCircle;
  emails: string; // JSON string[]
  phones: string; // JSON string[]
  address: string | null;
  headline: string | null; // one-line quick context, shown right under the name
  city: string | null; // free text — feeds the local-time display, see utils/timezones.ts
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  anniversary_month: number | null;
  anniversary_day: number | null;
  anniversary_year: number | null;
  pinned: number; // 0 | 1
  source: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactConnection {
  id: string;
  contact_id: string;
  related_contact_id: string | null;
  related_name: string;
  label: string;
  source: string; // 'manual' | 'import'
  created_at: string;
  updated_at: string;
}

export interface HouseholdMember {
  contactId: string;
  name: string;
}

// ---- Contact / voter-file import ----

/** One row parsed from an uploaded CSV or vCard, before matching. `raw`
 * carries the entire original row (or a compact vCard summary) — round-
 * tripped through preview and commit unchanged, and for a voter-file row
 * it's what lands in voter_records.raw_data so nothing from the source
 * file is lost even for columns this app has no dedicated field for. */
export interface ParsedContactRecord {
  name: string;
  emails: string[];
  phones: string[];
  address: string | null;
  company: string | null;
  title: string | null;
  circleHint: ContactCircle | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  party: string | null;
  voter_age: number | null;
  household_members: string[] | null;
  voting_history: unknown;
  relations: { label: string; name: string }[]; // Google Contacts "Relation N" columns, personal-contact imports only
  raw: Record<string, string>;
}

export interface ImportMatch {
  record: ParsedContactRecord;
  matchType: 'auto' | 'review' | 'new';
  existingContactId?: string;
  existingName?: string;
}

export interface ImportPreviewResponse {
  kind: 'contacts' | 'voter_file';
  filename: string;
  totalRows: number;
  auto: ImportMatch[];
  review: ImportMatch[];
  fresh: ImportMatch[];
}

export interface ImportDecision {
  record: ParsedContactRecord;
  action: 'merge' | 'new';
  contactId?: string;
}

/** The commit flow is chunked so one huge file (e.g. a 12k-row voter file)
 * never rides in a single request that can get killed partway through with
 * no trace — see worker/src/index.ts's processDecisionChunk comment for the
 * full story. Client flow: start() once, commitChunk() repeatedly with
 * bounded slices of the decisions array, finish() once at the end. */
export interface ImportCommitStartResponse {
  batchId: string;
}

export interface ImportCommitChunkResponse {
  newCount: number;
  updatedCount: number;
}

export type ImportBatchStatus = 'in_progress' | 'complete';

export interface ImportBatch {
  id: string;
  kind: 'contacts' | 'voter_file';
  filename: string;
  new_count: number;
  updated_count: number;
  status: ImportBatchStatus;
  total_rows: number | null;
  created_at: string;
}

/** GET /api/contacts/import/orphaned — real contact/voter_record rows left
 * behind by an import whose batch summary row never got written (the bug
 * the chunked commit flow fixes). Structurally can never match a manually-
 * created contact (import_batch_id IS NULL) or a normal completed import. */
export interface OrphanedImportsResponse {
  count: number;
  sample: { id: string; name: string; source: string; import_batch_id: string }[];
}

export interface ClearOrphanedImportsResponse {
  deletedCount: number;
}

/** DELETE /api/contacts/import/batch/:id — undo one whole import (only
 * contacts that batch newly created; a contact it merely filled in fields
 * on is untouched). Used to clean up after a parser bug and re-import. */
export interface DeleteImportBatchResponse {
  deletedCount: number;
}

/** GET /api/contacts/voter-names/preview — how many standalone voter-roll
 * contacts would be renamed (honorific/middle-initial stripped, Title
 * Case) by the bulk cleanup below, with a few before/after examples. */
export interface VoterNamesPreviewResponse {
  totalVoterContacts: number;
  changeCount: number;
  sample: { id: string; before: string; after: string }[];
}

/** POST /api/contacts/voter-names/cleanup-chunk — one bounded slice of the
 * bulk voter-name cleanup; the client loops this (same shape as the
 * chunked import commit) until `done`. Paged by keyset (nextCursor is the
 * last row id processed, fed back as afterId on the next call) rather than
 * OFFSET — OFFSET makes D1 re-read every already-seen row on each call,
 * which is what tripped Cloudflare's free-tier daily row-read cap the one
 * time this ran at full (~12k row) scale. */
export interface VoterNamesCleanupChunkResponse {
  processed: number;
  updated: number;
  nextCursor: string | null;
  done: boolean;
}

export type ContactNoteSourceType = 'quick_note' | 'jot' | 'note' | 'task';

/** A single quick, unstructured note tied to a contact — the Bill-Clinton-
 * index-card feature. `remind_at` is the optional "check back on this"
 * flag set at capture time (never inferred from the text); once past due
 * and unresolved it's meant to surface as a nudge until dismissed. */
export interface ContactNote {
  id: string;
  contact_id: string;
  text: string;
  source_type: ContactNoteSourceType;
  source_id: string | null;
  remind_at: string | null;
  remind_resolved: number; // 0 | 1
  created_at: string;
}

/** A blended-in row from a voter-file import — see migrations/0018_contact_import.sql.
 * Shown as its own section on the contact page, separate from the
 * personal info Mike maintains himself. `raw_data` carries the full
 * original CSV row so nothing the file contained is ever lost, even
 * columns we don't have a dedicated field for. */
export interface VoterRecord {
  id: string;
  contact_id: string;
  party: string | null;
  voter_age: number | null;
  household_members: string | null; // JSON string[] — unused for now, see 0022_voter_record_fields.sql
  voting_history: string | null; // JSON — VoterHistoryEntry[]
  gender: string | null;
  registered_date: string | null;
  phone: string | null;
  polling_place: string | null;
  causeway_tag: string | null;
  calculated_party: string | null;
  household_party: string | null;
  household_code: string | null;
  cd: string | null;
  sd: string | null;
  ad: string | null;
  ld: string | null;
  gop_matrix: string | null;
  raw_data: string; // JSON — the full original row
  import_batch_id: string;
  created_at: string;
  updated_at: string;
}

/** One entry in VoterRecord.voting_history — an election/participation
 * column from the voter file that wasn't promoted to its own field
 * (general/primary/special elections, vote-method notes, turnout-rate
 * summaries like "3/4 G"). `code` is the source file's own column header,
 * `value` is usually just that same code repeated (this file marks
 * participation by populating a cell with its own column name) but can
 * differ for a few fields like VOTE METHOD columns. */
export interface VoterHistoryEntry {
  code: string;
  value: string;
}

export interface ContactDetail extends Contact {
  notes: ContactNote[];
  voterRecords: VoterRecord[];
  connections: (ContactConnection & { direction: 'from' | 'to' })[];
  householdMembers: HouseholdMember[];
}

/** Manual dedup — for the pairs the import matcher's automatic name/
 * nickname rules still can't catch (a misspelling, an unlisted nickname).
 * Folds `mergeFromId` into the target contact (additive-only, same rule as
 * an import merge) and deletes it. */
export interface MergeContactRequest {
  mergeFromId: string;
}

/** GET /api/contacts/duplicates — likely duplicate pairs already sitting
 * in the database: one personal contact whose name matches one or more
 * standalone voter-roll contacts. `voters` can have more than one entry
 * (rare — two different voter-roll people whose names happen to reduce to
 * the same key); each still needs its own Merge click. Detection only —
 * nothing here is merged until POST /api/contacts/:id/merge runs. */
export interface DuplicateCandidate {
  key: string;
  personal: { id: string; name: string; circle: ContactCircle };
  voters: { id: string; name: string }[];
}

export interface DuplicateCandidatesResponse {
  candidates: DuplicateCandidate[];
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

/** Journal — see worker/src/index.ts's "Journal" section. journal_entries
 * only ever holds the freeform text Mike adds himself; everything else on
 * GET /api/journal/:date is computed live from the tables that already own
 * it (task_completions, task_reschedules, entities, contact_notes, habits/
 * habit_logs, health_logs), not duplicated storage. */
export interface JournalEntry {
  date: string; // 'YYYY-MM-DD'
  content: string | null; // Tiptap JSON
  search_text: string | null;
  mood: number | null; // 1 (rough) – 5 (great); null = not logged
  created_at: string;
  updated_at: string;
}

export interface TaskCompletionEvent {
  id: string;
  entity_id: string;
  title: string;
  completed_at: string;
  completed_date: string;
}

export interface TaskReschedule {
  id: string;
  entity_id: string;
  title: string;
  from_due_date: string;
  to_due_date: string;
  rescheduled_at: string;
  rescheduled_date: string;
}

export interface JournalNote {
  id: string;
  title: string;
  is_jot: number; // 0 | 1
  /** Whether this note lives at the top level (Notes section) or nested
   * inside a project/folder — decides which route actually resolves it:
   * /notes/:id only ever looks at top-level notes, so a nested note has to
   * go through /projects/:id instead (that page is generic over entity
   * type and walks parent_id for the breadcrumb). */
  is_top_level: number; // 0 | 1
  created_at: string;
}

export interface JournalContactNote {
  id: string;
  contact_id: string;
  text: string;
  created_at: string;
  contact_name: string;
}

export interface HabitLog {
  habit_id: string;
  date: string;
  value: number;
  created_at: string;
  updated_at: string;
}

/** A habit is quantified rather than plain done/not-done — `unit`/
 * `target_value` are both optional, so a simple habit just logs 1 (or any
 * number) per day with no target shown. `log` is this specific day's value,
 * attached only on GET /api/journal/:date's habit list — null means nothing
 * logged for that habit on that day yet. */
export interface Habit {
  id: string;
  name: string;
  unit: string | null;
  target_value: number | null;
  active: number; // 0 | 1
  position: number;
  created_at: string;
  updated_at: string;
  log?: HabitLog | null;
}

export interface HealthLog {
  date: string;
  raw_data: string; // JSON — full parsed row from the Google Health export, shape TBD
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

// One row per Google Health weekly-report import — mirrors
// worker/src/types.ts's HealthWeeklyReport. See
// worker/migrations/0025_health_weekly_reports.sql for the field-by-field
// rationale (self-computed deltas, per-metric null handling for weeks the
// tracker wasn't worn).
export interface HealthWeeklyReport {
  week_start: string; // 'YYYY-MM-DD'
  week_end: string; // 'YYYY-MM-DD'
  total_steps: number | null;
  avg_steps_per_day: number | null;
  best_day_steps: number | null;
  best_day_weekday: string | null;
  total_floors: number | null;
  total_miles: number | null;
  avg_calories_burned: number | null;
  avg_active_zone_minutes: number | null;
  avg_restful_sleep_minutes: number | null;
  avg_hours_with_250_steps: number | null;
  avg_resting_heart_rate: number | null;
  avg_weight_lb: number | null;
  raw_text: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/health/parse — preview-only, no DB write. `week` is null when
 * the text didn't match the Google Health template at all (see
 * HealthParseError in worker/src/health.ts); `error` then holds the reason
 * to show the user. `existing` is the already-stored row for that week, if
 * any — so the Settings panel can show "this will update Sep 5 - Sep 11"
 * rather than silently overwriting. */
export interface HealthParsePreview {
  filename: string;
  week: Omit<HealthWeeklyReport, 'raw_text' | 'import_batch_id' | 'created_at' | 'updated_at'> | null;
  error: string | null;
  existing: HealthWeeklyReport | null;
}

export interface HealthImportResponse {
  imported: number;
  weeks: string[]; // week_start values written, oldest first
}

// Computed live from `bets` by GET /api/journal/:date, exactly like every
// other block on this response — never stored on journal_entries. Absent
// (null) on a day with zero bets, matching notes/contactNotes' convention
// of just not rendering a section rather than showing an empty one.
export interface JournalDayBets {
  count: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  net: number;
  items: Bet[];
}

export interface JournalDayResponse {
  date: string;
  entry: JournalEntry | null;
  tasksCompleted: TaskCompletionEvent[];
  tasksPushed: TaskReschedule[];
  notes: JournalNote[];
  contactNotes: JournalContactNote[];
  habits: Habit[];
  health: HealthWeeklyReport | null;
  bets: JournalDayBets | null;
}

// ---- News (RSS reader) ----

export interface NewsFeed {
  id: string;
  url: string;
  title: string;
  folder: string | null; // null = "Uncategorized", same convention as unfoldered feeds in Feedly
  site_url: string | null;
  favicon_url: string | null;
  position: number;
  last_fetch_error: string | null; // set when the most recent fetch failed (bad URL, feed down, etc.) so Settings can flag it
  created_at: string;
  updated_at: string;
  unread_count: number; // computed server-side from the cached article table
}

/** A fetched-and-cached feed item. Cached (not fetched live per read) so
 * read/saved state has a stable id to key off of across devices — see
 * worker/migrations/0026_news.sql's header comment. */
export interface NewsArticle {
  id: string;
  feed_id: string;
  feed_title: string;
  feed_folder: string | null;
  url: string;
  title: string;
  description: string | null; // plain text, tags stripped, truncated — for the list-view preview and story-view card
  image_url: string | null;
  published_at: string | null; // ISO, null if the feed item had no date
  fetched_at: string;
  is_read: boolean;
  is_saved: boolean;
}

/** Auto-mark-as-read: articles older than auto_read_hours silently clear
 * out of the unread feed on their own. null = disabled. */
export interface NewsSettings {
  auto_read_hours: number | null;
}

export interface NewsArticlesResponse {
  articles: NewsArticle[];
  stale_feeds: string[]; // feed ids that failed to refresh this call (network error etc.) — surfaced so the UI can say "some feeds didn't update" instead of silently showing old data
}

export interface NewsSavedArticle {
  id: string;
  article_id: string | null;
  feed_title: string | null;
  title: string;
  url: string;
  image_url: string | null;
  description: string | null;
  saved_at: string;
}

// ---- Global search (Cmd/Ctrl+K palette) ----

export type SearchGroupKey = 'notes' | 'jots' | 'lists' | 'projects' | 'boards' | 'contacts' | 'journal' | 'meeting_notes' | 'links';

export interface SearchResult {
  id: string;
  kind: string;
  group: SearchGroupKey;
  title: string;
  snippet: string | null;
  parentTitle: string | null;
  path: string;
  openId: string | null; // pass as router state ({openId}) when navigating to `path` — see /api/search's comment for which pages consume it
  updatedAt: string;
  score: number;
}

export interface SearchGroupResult {
  key: SearchGroupKey;
  results: SearchResult[];
}

export interface SearchResponse {
  groups: SearchGroupResult[];
}

// ---- Daily Briefing ----

export interface BriefingRelated {
  id: string;
  group: SearchGroupKey;
  title: string;
  path: string;
  openId: string | null;
}

export interface BriefingAttendee {
  name: string | null;
  email: string;
  contactId: string | null;
  contactName: string | null;
}

export interface BriefingContactNote {
  contactId: string;
  contactName: string;
  text: string;
  createdAt: string;
}

export interface BriefingMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  gcalUrl: string | null;
  hasNote: boolean;
  noteEntityId: string | null;
  location: string | null;
  links: string[];
  attendees: BriefingAttendee[];
  contactNotes: BriefingContactNote[];
  related: BriefingRelated[];
}

export interface BriefingUpcomingDate {
  type: 'birthday' | 'anniversary';
  contactId: string;
  name: string;
  inDays: number;
}

export interface BriefingTaskRef {
  id: string;
  title: string;
}

export interface BriefingInsights {
  overdueCount: number;
  overdueTasks: (BriefingTaskRef & { due_date: string })[];
  dueTodayCount: number;
  dueTodayTasks: BriefingTaskRef[];
  upcomingDates: BriefingUpcomingDate[];
  staleProjects: (BriefingTaskRef & { last_touched: string })[];
}

export interface BriefingRetrospective {
  weekStart: string;
  tasksCompleted: number;
  tasksCompletedPrevWeek: number;
  journalDays: number;
  avgMood: number | null;
  moodDays: { date: string; mood: number }[];
  topProjects: { id: string; title: string; n: number }[];
}

export interface BriefingResponse {
  date: string;
  meetings: BriefingMeeting[];
  insights: BriefingInsights;
  retrospective: BriefingRetrospective;
}

// ---- Bets (sports betting dashboard, 0032_bets.sql) ----

export type BetResult = 'win' | 'loss' | 'push' | 'void';

// Only ever non-empty when bet_type is 'Parlay' | 'Same Game Parlay' |
// 'SGP+' — see worker/migrations/0038_bet_legs.sql for the money-vs-
// pick-accuracy split this exists for.
export interface BetLeg {
  id: string;
  bet_id: string;
  sport: string;
  bet_type: string;
  pick: string | null;
  line: number | null;
  over_under: 'over' | 'under' | null;
  odds: number | null;
  result: BetResult;
  position: number;
  created_at: string;
}

export interface Bet {
  id: string;
  date: string; // 'YYYY-MM-DD'
  sport: string;
  sportsbook: string;
  bet_type: string;
  pick: string | null;
  odds: number; // American odds
  wager: number;
  result: BetResult;
  manual_profit: number | null;
  notes: string | null;
  legs: BetLeg[];
  created_at: string;
  updated_at: string;
}

// ---- App-wide authentication (0033_auth.sql) ----

export type AuthCredentialType = 'webauthn' | 'pin';

export interface AuthStatus {
  has_credentials: boolean;
  has_webauthn: boolean;
  has_pin: boolean;
  authenticated: boolean;
}

export interface AuthCredentialSummary {
  id: string;
  type: AuthCredentialType;
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}

// ---- Vault (0034_vault.sql) ----

export type VaultFieldType = 'text' | 'number' | 'date' | 'currency' | 'url' | 'contact' | 'duration' | 'list';

export const VAULT_FIELD_TYPES: { value: VaultFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'currency', label: 'Currency' },
  { value: 'url', label: 'Link' },
  { value: 'contact', label: 'Contact' },
  { value: 'duration', label: 'Duration' },
  { value: 'list', label: 'List (multi-line)' },
];

export interface VaultFieldDef {
  id: string;
  name: string;
  field_type: VaultFieldType;
  created_at: string;
}

export interface VaultGroupField {
  id: string;
  group_id: string;
  field_def_id: string;
  position: number;
  field_name: string;
  field_type: VaultFieldType;
}

export interface VaultFieldGroup {
  id: string;
  name: string;
  created_at: string;
  fields: VaultGroupField[];
}

export interface VaultTemplate {
  id: string;
  name: string;
  starter_content: string | null;
  created_at: string;
  groups: VaultFieldGroup[];
}

export interface VaultCategory {
  id: string;
  name: string;
  icon: string;
  trigger_field_def_id: string;
  created_at: string;
}

export interface VaultFieldValue {
  id: string;
  entry_group_id: string;
  field_def_id: string;
  value: string | null;
  position: number;
}

export interface VaultEntryGroup {
  id: string;
  entry_id: string;
  group_id: string;
  label: string | null;
  position: number;
  created_at: string;
  group: VaultFieldGroup | null;
  values: VaultFieldValue[];
}

// ---- Vault v2 (0036_vault_facts.sql) — a flat, inline quick-facts list
// per entry, replacing the field/group/template registry above (which is
// left in place server-side, unused, rather than migrated).

export interface VaultFact {
  id: string;
  entry_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

export interface VaultEntryDetail extends Entity {
  facts: VaultFact[];
}

export interface VaultRollupEntry {
  factId: string;
  entryId: string;
  entryTitle: string;
  value: string | null;
}

export interface VaultRollupGroup {
  label: string;
  count: number;
  entries: VaultRollupEntry[];
}
