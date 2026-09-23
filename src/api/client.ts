import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import type { AuthCredentialSummary, AuthStatus, Bet, BetLeg, VaultEntryDetail, VaultFact, BriefingResponse, CalendarFeedsResponse, CalendarFeedStatus, CanvasBoard, CanvasBoardDetail, CanvasBoardListItem, CanvasConnector, CanvasItem, CanvasItemType, ClearOrphanedImportsResponse, CompletionsResponse, ConnectorItemContent, Contact, ContactCircle, ContactConnection, ContactDetail, ContactNote, DeleteImportBatchResponse, DuplicateCandidatesResponse, Entity, EntityDetail, EntityType, Habit, HabitLog, HealthImportResponse, HealthParsePreview, HealthWeeklyReport, ImportBatch, ImportCommitChunkResponse, ImportCommitStartResponse, ImportDecision, ImportPreviewResponse, JournalDayResponse, JournalEntry, ListItem, MeetingsRangeResponse, MeetingsResponse, MonthResponse, NewsArticlesResponse, NewsFeed, NewsSavedArticle, NewsSettings, OrphanedImportsResponse, ProjectListItem, QuickLink, QuickLinksResponse, RecurringTaskDefinition, SearchGroupKey, SearchResponse, ShelfItem, ShelfItemType, StatsResponse, TodayResponse, TopNewsResponse, VoterNamesCleanupChunkResponse, VoterNamesPreviewResponse, VaultFactLabel, VaultRollupGroup, WeatherResponse, WeekResponse } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

// Fired whenever any API call comes back 401 — a session that expired (or
// was revoked from another device) mid-use, not just the initial locked
// state. AuthContext listens for this to drop back to the lock screen
// immediately instead of leaving the app showing stale data next to
// requests that are silently failing.
export const UNAUTHORIZED_EVENT = 'mikeos:unauthorized';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include', // send/receive the mikeos_session cookie cross-origin (Pages <-> Workers)
    headers: {
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Shared with createLink below, and with anywhere a stored LinkMeta.url is
// turned into an href — a link saved before this normalization existed (or
// entered without a scheme some other way) still needs to resolve as an
// external site rather than a path on the app itself.
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const api = {
  listProjects: () => request<ProjectListItem[]>('/api/projects'),

  createProject: (title: string, description: string) =>
    request<Entity>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    }),

  getEntity: (id: string) => request<EntityDetail>(`/api/entities/${id}`),

  createEntity: (params: {
    type: Exclude<EntityType, 'project' | 'file'>;
    title?: string;
    content?: string | null;
    parent_id: string;
    status?: string | null;
  }) =>
    request<Entity>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  createLink: (parent_id: string, url: string, title?: string) => {
    // Without a scheme, an href like "espn.com" resolves as a path
    // relative to the app itself (opening MikeOS at /espn.com) instead of
    // the external site — normalize once here so every caller gets a real,
    // externally-openable URL regardless of whether it prompted the user
    // to include "https://" or not.
    const normalized = normalizeUrl(url);
    return request<Entity>('/api/entities', {
      method: 'POST',
      body: JSON.stringify({ type: 'link', parent_id, content: JSON.stringify({ url: normalized }), title: title || normalized }),
    });
  },

  uploadFile: async (file: File, parent_id?: string): Promise<Entity> => {
    const form = new FormData();
    form.append('file', file);
    if (parent_id) form.append('parent_id', parent_id);
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form, credentials: 'include' });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  },

  /** Inline upload for note attachments — returns the file's URL/metadata
   * without creating a folder-level entity. */
  uploadInline: async (file: File): Promise<{ url: string; filename: string; mime_type: string; size: number; r2_key: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form, credentials: 'include' });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    // The worker returns a path relative to itself (e.g. "/api/files/xyz");
    // resolve it against API_BASE here so embedding it directly in an <img>/
    // <iframe> src or a download link works regardless of what origin the
    // app itself is served from.
    return { ...data, url: `${API_BASE}${data.url}` };
  },

  fileUrl: (key: string, download = false) => `${API_BASE}/api/files/${key}${download ? '?download=1' : ''}`,

  deleteFileKey: (key: string) => request<{ ok: true }>(`/api/files/${key}`, { method: 'DELETE' }),

  updateEntity: (
    id: string,
    patch: Partial<
      Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned' | 'due_date' | 'due_time' | 'last_touched'>
    >
  ) =>
    request<Entity>(`/api/entities/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteEntity: (id: string) =>
    request<{ ok: true }>(`/api/entities/${id}`, { method: 'DELETE' }),

  reorder: (parent_id: string | null, ordered_ids: string[]) =>
    request<{ ok: true }>('/api/entities/reorder', {
      method: 'POST',
      body: JSON.stringify({ parent_id, ordered_ids }),
    }),

  setPinned: (id: string, pinned: boolean) =>
    request<Entity>(`/api/entities/${id}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),

  // ---- Lists (flat checklists — see migrations/0029_lists.sql) ----

  listLists: () => request<ListItem[]>('/api/lists'),

  createList: (title: string) =>
    request<Entity>('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  /** Bulk-create list items from pasted/typed lines, one task per non-blank
   * line, in one round trip. */
  createListItems: (listId: string, titles: string[]) =>
    request<{ items: Entity[] }>(`/api/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify({ titles }),
    }),

  /** Global search (Cmd/Ctrl+K palette). `scope` empty/omitted searches
   * every group; pass a subset to narrow (combinable, e.g. ['jots','notes']). */
  search: (q: string, scope: SearchGroupKey[] = [], includeArchived = false) => {
    const params = new URLSearchParams({ q });
    if (scope.length) params.set('scope', scope.join(','));
    if (includeArchived) params.set('archived', '1');
    return request<SearchResponse>(`/api/search?${params.toString()}`);
  },

  getBriefing: (date: string) => request<BriefingResponse>(`/api/briefing?date=${encodeURIComponent(date)}`),

  listNotes: () => request<Entity[]>('/api/notes'),

  createNote: (title?: string, content?: string | null) =>
    request<Entity>('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    }),

  /** Reparents an entity — used for "Move to Project" (parent_id: a
   * project/folder id) and its reverse, "Move to Notes" (parent_id: null). */
  moveEntity: (id: string, parent_id: string | null) =>
    request<Entity>(`/api/entities/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ parent_id }),
    }),

  // ---- Jots ----

  listJots: () => request<Entity[]>('/api/jots'),

  createJot: (content?: string | null) =>
    request<Entity>('/api/jots', {
      method: 'POST',
      body: JSON.stringify({ content: content ?? null }),
    }),

  /** Turns a Jot into a Note or a Task — parent_id may be null for either
   * (a standalone Note, or a standalone Task with no project, same
   * "addressable at the root" pattern Jots themselves use). due_date is
   * only meaningful when to: 'task' — used by "Plan for a date". */
  convertEntity: (id: string, to: 'note' | 'task', parent_id: string | null, due_date?: string | null) =>
    request<Entity>(`/api/entities/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ to, parent_id, due_date }),
    }),

  // ---- Shelf (self-clearing drop zone on the Jots page) ----

  listShelf: () => request<ShelfItem[]>('/api/shelf'),

  dropShelfItem: (type: ShelfItemType, content: Record<string, unknown>) =>
    request<ShelfItem>('/api/shelf', {
      method: 'POST',
      body: JSON.stringify({ type, content }),
    }),

  setShelfItemPinned: (id: string, pinned: boolean) =>
    request<ShelfItem>(`/api/shelf/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),

  deleteShelfItem: (id: string) => request<{ ok: true }>(`/api/shelf/${id}`, { method: 'DELETE' }),

  /** Turns a shelf item into an ordinary Jot and removes it from the shelf
   * — the one way something on the shelf becomes permanent short of
   * pinning it. */
  graduateShelfItem: (id: string) => request<Entity>(`/api/shelf/${id}/graduate`, { method: 'POST' }),

  // ---- Contacts (personal CRM) ----

  listContacts: (opts?: { q?: string; circle?: ContactCircle; remindersOnly?: boolean; includeVoters?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.q) params.set('q', opts.q);
    if (opts?.circle) params.set('circle', opts.circle);
    if (opts?.remindersOnly) params.set('reminders', '1');
    if (opts?.includeVoters) params.set('voters', '1');
    const qs = params.toString();
    return request<Contact[]>(`/api/contacts${qs ? `?${qs}` : ''}`);
  },

  createContact: (params: { name: string; circle?: ContactCircle }) =>
    request<Contact>('/api/contacts', { method: 'POST', body: JSON.stringify(params) }),

  getContact: (id: string) => request<ContactDetail>(`/api/contacts/${id}`),

  updateContact: (id: string, params: Partial<Contact>) =>
    request<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(params) }),

  setContactPinned: (id: string, pinned: boolean) =>
    request<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }),

  deleteContact: (id: string) => request<{ ok: true }>(`/api/contacts/${id}`, { method: 'DELETE' }),

  /** Manual duplicate cleanup — folds mergeFromId into id (additive-only:
   * only fills blank fields, unions emails/phones) and deletes mergeFromId,
   * moving its notes and any voter record over. For duplicates the import
   * matcher's name/nickname rules don't catch on their own. */
  mergeContact: (id: string, mergeFromId: string) =>
    request<Contact>(`/api/contacts/${id}/merge`, { method: 'POST', body: JSON.stringify({ mergeFromId }) }),

  /** Scans for likely duplicates already in the database — a personal
   * contact whose name matches one or more standalone voter-roll contacts.
   * Detection only; each candidate still needs its own mergeContact call. */
  listDuplicateCandidates: () => request<DuplicateCandidatesResponse>('/api/contacts/duplicates'),

  addContactNote: (contactId: string, text: string, remindInDays?: number) =>
    request<ContactNote>(`/api/contacts/${contactId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ text, remind_in_days: remindInDays }),
    }),

  resolveContactNoteReminder: (contactId: string, noteId: string, resolved: boolean) =>
    request<ContactNote>(`/api/contacts/${contactId}/notes/${noteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ remind_resolved: resolved }),
    }),

  deleteContactNote: (contactId: string, noteId: string) =>
    request<{ ok: true }>(`/api/contacts/${contactId}/notes/${noteId}`, { method: 'DELETE' }),

  addContactConnection: (contactId: string, params: { relatedContactId?: string | null; relatedName?: string; label: string }) =>
    request<ContactConnection>(`/api/contacts/${contactId}/connections`, { method: 'POST', body: JSON.stringify(params) }),

  deleteContactConnection: (contactId: string, connectionId: string) =>
    request<{ ok: true }>(`/api/contacts/${contactId}/connections/${connectionId}`, { method: 'DELETE' }),

  previewContactImport: (content: string, filename: string, kind: 'contacts' | 'voter_file') =>
    request<ImportPreviewResponse>('/api/contacts/import/preview', {
      method: 'POST',
      body: JSON.stringify({ content, filename, kind }),
    }),

  /** Chunked commit flow — call start() once, then commitChunk() repeatedly
   * with bounded slices of the full decisions array (so one huge file never
   * rides in a single request that can be killed partway through with no
   * trace), then finish() once. See ImportCommitStartResponse's comment. */
  startContactImportCommit: (kind: 'contacts' | 'voter_file', filename: string, totalRows: number) =>
    request<ImportCommitStartResponse>('/api/contacts/import/commit/start', {
      method: 'POST',
      body: JSON.stringify({ kind, filename, totalRows }),
    }),

  commitContactImportChunk: (batchId: string, kind: 'contacts' | 'voter_file', decisions: ImportDecision[]) =>
    request<ImportCommitChunkResponse>('/api/contacts/import/commit/chunk', {
      method: 'POST',
      body: JSON.stringify({ batchId, kind, decisions }),
    }),

  finishContactImportCommit: (batchId: string) =>
    request<ImportBatch>('/api/contacts/import/commit/finish', {
      method: 'POST',
      body: JSON.stringify({ batchId }),
    }),

  listImportHistory: () => request<ImportBatch[]>('/api/contacts/import/history'),

  /** Real contact/voter_record rows left behind by an import that died
   * before its batch summary row was written — the production bug the
   * chunked commit flow above fixes. Settings surfaces this so Mike can
   * clean it up himself rather than it silently lingering. */
  getOrphanedImports: () => request<OrphanedImportsResponse>('/api/contacts/import/orphaned'),

  clearOrphanedImports: () => request<ClearOrphanedImportsResponse>('/api/contacts/import/orphaned', { method: 'DELETE' }),

  /** Undoes one whole import — only the contacts it newly created, not any
   * it merely filled in fields on. For cleaning up after a bad import
   * (a parser bug, the wrong file) so it can be re-run cleanly. */
  deleteImportBatch: (batchId: string) =>
    request<DeleteImportBatchResponse>(`/api/contacts/import/batch/${batchId}`, { method: 'DELETE' }),

  /** Bulk voter-name cleanup — strips honorifics/middle initials and
   * Title-Cases standalone voter-roll contacts already sitting in the DB
   * with their raw, ALL-CAPS import name. previewVoterNameCleanup shows
   * the count before running; cleanupVoterNamesChunk does the actual work
   * in bounded slices the client loops through. */
  previewVoterNameCleanup: () => request<VoterNamesPreviewResponse>('/api/contacts/voter-names/preview'),

  cleanupVoterNamesChunk: (afterId: string | null, limit: number) =>
    request<VoterNamesCleanupChunkResponse>('/api/contacts/voter-names/cleanup-chunk', {
      method: 'POST',
      body: JSON.stringify({ afterId, limit }),
    }),

  // ---- Health dashboard (Google Health weekly-report import) ----

  /** Preview-only — parses `text` (already extracted client-side from the
   * PDF, see src/utils/pdfText.ts) and returns the structured week without
   * writing anything, plus whatever's already stored for that week so the
   * Settings panel can show "this will update Sep 5 - Sep 11" up front. */
  previewHealthImport: (filename: string, text: string) =>
    request<HealthParsePreview>('/api/health/parse', {
      method: 'POST',
      body: JSON.stringify({ filename, text }),
    }),

  /** Commits one or more previewed files in a single request — each is
   * re-parsed and upserted by week_start server-side. */
  commitHealthImport: (imports: { filename: string; text: string }[]) =>
    request<HealthImportResponse & { errors: { filename: string; error: string }[] }>('/api/health/import', {
      method: 'POST',
      body: JSON.stringify({ imports }),
    }),

  /** Full history, oldest first — feeds the Health dashboard's trend
   * charts and current-week tiles. */
  listHealthWeekly: () => request<HealthWeeklyReport[]>('/api/health/weekly'),

  // ---- Today (daily planner) ----

  /** `date` is the day being viewed; `today` is the viewer's own local
   * "today" so the server can tell a future preview apart from the real
   * current day when deciding what counts as Overdue. */
  getToday: (date: string, today: string) =>
    request<TodayResponse>(`/api/today?date=${encodeURIComponent(date)}&today=${encodeURIComponent(today)}`),

  /** `start` is the Monday of the week to show; `today` is the viewer's own
   * local "today" so the server knows which column (if any) gets the
   * Overdue/Tickler strip. */
  getWeek: (start: string, today: string) =>
    request<WeekResponse>(`/api/week?start=${encodeURIComponent(start)}&today=${encodeURIComponent(today)}`),

  /** `start`/`end` are the full visible grid (spilling into the
   * previous/next month's padding days), not just the calendar month. */
  getMonth: (start: string, end: string) =>
    request<MonthResponse>(`/api/month?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),

  /** Real Google Calendar events (not tasks) due on `date` — Day view only,
   * see the worker's /api/meetings comment for the ICS-feed approach. */
  getMeetings: (date: string) => request<MeetingsResponse>(`/api/meetings?date=${encodeURIComponent(date)}`),

  /** Bulk fetch for Week/Month — every meeting anywhere in [start, end],
   * each tagged with its own local date. See the worker's /api/meetings/range
   * comment for why this beats one /api/meetings call per visible day. */
  getMeetingsRange: (start: string, end: string) =>
    request<MeetingsRangeResponse>(`/api/meetings/range?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),

  /** The real note entity linked to a meeting occurrence, or
   * `{ noteEntityId: null }` if the note icon hasn't been clicked yet —
   * see /api/meetings/:meetingId/note. */
  getMeetingNote: (meetingId: string) =>
    request<{ noteEntityId: string | null }>(`/api/meetings/${encodeURIComponent(meetingId)}/note`),

  /** Creates (or, if one already exists, just returns) the real note entity
   * for this meeting, titled `title` — see the worker's POST handler.
   * Nothing is created until this is actually called, i.e. until the note
   * icon is clicked. */
  createMeetingNote: (meetingId: string, title: string) =>
    request<{ noteEntityId: string }>(`/api/meetings/${encodeURIComponent(meetingId)}/note`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  /** Completed-task rollups (today/week/month/year + a 14-day trend),
   * anchored on the viewer's own local `date` — see the worker's
   * /api/stats comment. Used by both the Today page's small completion
   * count and the standalone Stats page. */
  getStats: (date: string) => request<StatsResponse>(`/api/stats?date=${encodeURIComponent(date)}`),

  /** The completion log itself, newest first — the Stats page's "find when
   * I did X" list. `q` filters by title substring; `before` (a completed_at
   * cursor, from the last row of a previous page) fetches further back for
   * "load more" rather than re-fetching from the top. */
  getCompletions: (opts: { q?: string; before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.before) params.set('before', opts.before);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<CompletionsResponse>(`/api/stats/completions${qs ? `?${qs}` : ''}`);
  },

  /** Quick-add on the Today page — a standalone task with no project,
   * due on the given date. */
  createStandaloneTask: (title: string, due_date: string) =>
    request<Entity>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, due_date }),
    }),

  /** Promote/demote on the Day view — persists a new order for exactly the
   * tasks due on `date` (see the worker's /api/tasks/reorder-day comment
   * for why this is separate from the project-scoped api.reorder above). */
  reorderDay: (date: string, ordered_ids: string[]) =>
    request<{ ok: true }>('/api/tasks/reorder-day', {
      method: 'POST',
      body: JSON.stringify({ date, ordered_ids }),
    }),

  /** Daily forecast for the next ~16 days at Mike's fixed home location —
   * see the worker's /api/weather comment. No params: one location, one
   * forecast window, cached at the edge, so every caller gets the same
   * response and just looks up the date(s) it needs. */
  getWeather: () => request<WeatherResponse>('/api/weather'),

  /** The Today page's "Top Stories" block — server-cached on a TTL (see
   * computeTopNews), so this is cheap to call on every page load; the
   * worker only actually re-fetches the source feed once the cache goes
   * stale. */
  getTopNews: () => request<TopNewsResponse>('/api/top-news'),

  /** Server-side link unfurl (og:title/og:image + bare domain fallback) for
   * the editor's "Insert link preview" button — a browser-side fetch would
   * hit CORS on nearly every real site. */
  fetchLinkPreview: (url: string) =>
    request<{ url: string; title: string | null; image: string | null; domain: string | null }>(
      `/api/link-preview?url=${encodeURIComponent(url)}`
    ),

  // ---- Recurring task definitions (Settings screen) ----

  listRecurring: () => request<RecurringTaskDefinition[]>('/api/recurring'),

  createRecurring: (params: { title: string; project_id?: string | null; rrule: string; dtstart: string; active?: boolean }) =>
    request<RecurringTaskDefinition>('/api/recurring', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  updateRecurring: (
    id: string,
    patch: Partial<{ title: string; project_id: string | null; rrule: string; dtstart: string; active: boolean }>
  ) =>
    request<RecurringTaskDefinition>(`/api/recurring/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteRecurring: (id: string) => request<{ ok: true }>(`/api/recurring/${id}`, { method: 'DELETE' }),

  /** Human-readable summary of an RRULE string (e.g. "every week on Monday")
   * for the live preview in the create/edit form. */
  previewRrule: (rrule: string, dtstart: string) =>
    request<{ text: string }>(`/api/recurring/preview?rrule=${encodeURIComponent(rrule)}&dtstart=${encodeURIComponent(dtstart)}`),

  // ---- Calendar feeds (Settings screen) ----

  /** Every calendar feed with live connection health — the Settings
   * screen's Calendar Integrations panel. */
  listCalendarFeeds: (today: string) => request<CalendarFeedsResponse>(`/api/calendars?today=${encodeURIComponent(today)}`),

  createCalendarFeed: (params: { label: string; url: string; active?: boolean }) =>
    request<CalendarFeedStatus>('/api/calendars', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  updateCalendarFeed: (id: string, patch: Partial<{ label: string; url: string; active: boolean }>) =>
    request<CalendarFeedStatus>(`/api/calendars/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteCalendarFeed: (id: string) => request<{ ok: true }>(`/api/calendars/${id}`, { method: 'DELETE' }),

  // ---- Quick Links (sidebar "Links" page + its Settings management panel) ----

  listQuickLinks: () => request<QuickLinksResponse>('/api/quick-links'),

  createQuickLink: (params: {
    name: string;
    url: string;
    type: 'open' | 'copy';
    icon?: string | null;
    thumbnail_key?: string | null;
    category?: string;
  }) =>
    request<QuickLink>('/api/quick-links', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  updateQuickLink: (
    id: string,
    patch: Partial<{
      name: string;
      url: string;
      type: 'open' | 'copy';
      icon: string | null;
      thumbnail_key: string | null;
      category: string;
      sort_order: number;
    }>
  ) =>
    request<QuickLink>(`/api/quick-links/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteQuickLink: (id: string) => request<{ ok: true }>(`/api/quick-links/${id}`, { method: 'DELETE' }),

  // ---- Canvas boards (infinite-canvas pinboard) ----

  listBoards: () => request<CanvasBoardListItem[]>('/api/boards'),

  createBoard: (title?: string) =>
    request<CanvasBoard>('/api/boards', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  getBoard: (id: string) => request<CanvasBoardDetail>(`/api/boards/${id}`),

  renameBoard: (id: string, title: string) =>
    request<CanvasBoard>(`/api/boards/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  setBoardPinned: (id: string, pinned: boolean) =>
    request<CanvasBoard>(`/api/boards/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),

  deleteBoard: (id: string) => request<{ ok: true }>(`/api/boards/${id}`, { method: 'DELETE' }),

  createBoardItem: (boardId: string, item: { type: CanvasItemType; x: number; y: number; width: number; height: number; content: Record<string, unknown> | ConnectorItemContent; title?: string | null }) =>
    request<CanvasItem>(`/api/boards/${boardId}/items`, {
      method: 'POST',
      body: JSON.stringify(item),
    }),

  updateBoardItem: (id: string, patch: Partial<{ x: number; y: number; width: number; height: number; z_index: number; content: Record<string, unknown> | ConnectorItemContent; title: string | null }>) =>
    request<CanvasItem>(`/api/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteBoardItem: (id: string) => request<{ ok: true }>(`/api/items/${id}`, { method: 'DELETE' }),

  createConnector: (boardId: string, fromItemId: string, toItemId: string) =>
    request<CanvasConnector>(`/api/boards/${boardId}/connectors`, {
      method: 'POST',
      body: JSON.stringify({ from_item_id: fromItemId, to_item_id: toItemId }),
    }),

  deleteConnector: (id: string) => request<{ ok: true }>(`/api/connectors/${id}`, { method: 'DELETE' }),

  // ---- Journal ----
  getJournalDay: (date: string) => request<JournalDayResponse>(`/api/journal/${date}`),

  updateJournalEntry: (date: string, content: string) =>
    request<JournalEntry>(`/api/journal/${date}`, { method: 'PATCH', body: JSON.stringify({ content }) }),

  updateJournalMood: (date: string, mood: number | null) =>
    request<JournalEntry>(`/api/journal/${date}`, { method: 'PATCH', body: JSON.stringify({ mood }) }),

  getJournalMoods: (start: string, end: string) =>
    request<{ moods: { date: string; mood: number }[] }>(`/api/journal/moods?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),

  listHabits: (includeArchived = false) => request<Habit[]>(`/api/habits${includeArchived ? '?archived=1' : ''}`),

  createHabit: (name: string, unit?: string | null, targetValue?: number | null) =>
    request<Habit>('/api/habits', { method: 'POST', body: JSON.stringify({ name, unit, target_value: targetValue }) }),

  updateHabit: (id: string, patch: Partial<Pick<Habit, 'name' | 'unit' | 'target_value' | 'active' | 'position'>>) =>
    request<Habit>(`/api/habits/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteHabit: (id: string) => request<{ ok: true }>(`/api/habits/${id}`, { method: 'DELETE' }),

  logHabit: (habitId: string, date: string, value: number) =>
    request<HabitLog>(`/api/habits/${habitId}/logs`, { method: 'POST', body: JSON.stringify({ date, value }) }),

  deleteHabitLog: (habitId: string, date: string) =>
    request<{ ok: true }>(`/api/habits/${habitId}/logs/${date}`, { method: 'DELETE' }),

  // ---- News (RSS reader) ----

  listNewsFeeds: () => request<NewsFeed[]>('/api/news/feeds'),

  addNewsFeed: (url: string, folder?: string | null) =>
    request<NewsFeed>('/api/news/feeds', { method: 'POST', body: JSON.stringify({ url, folder: folder || null }) }),

  updateNewsFeed: (id: string, patch: Partial<Pick<NewsFeed, 'title' | 'folder' | 'position'>>) =>
    request<NewsFeed>(`/api/news/feeds/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteNewsFeed: (id: string) => request<{ ok: true }>(`/api/news/feeds/${id}`, { method: 'DELETE' }),

  getNewsSettings: () => request<NewsSettings>('/api/news/settings'),

  updateNewsSettings: (autoReadHours: number | null) =>
    request<NewsSettings>('/api/news/settings', { method: 'PUT', body: JSON.stringify({ auto_read_hours: autoReadHours }) }),

  /** Refreshes (subject to each feed's own 15-min server cache) and returns
   * articles. Pass feedId for a single feed, folder for everything in a
   * folder, or neither for "All". unreadOnly narrows to unread articles
   * only — used by both the list view's "Unread" filter and story mode
   * (which only ever wants unread articles to flip through). recentlyRead
   * is the "fail-safe" view instead: the last 25 articles marked read
   * (within scope), newest-read first — mutually exclusive with
   * unreadOnly, and skips the feed refresh (read state can't change from
   * one) so it comes back faster. */
  listNewsArticles: (opts?: { feedId?: string; folder?: string | null; unreadOnly?: boolean; recentlyRead?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.feedId) params.set('feed_id', opts.feedId);
    if (opts?.folder !== undefined && opts.folder !== null) params.set('folder', opts.folder);
    if (opts?.recentlyRead) params.set('recently_read', '1');
    else if (opts?.unreadOnly) params.set('unread_only', '1');
    const qs = params.toString();
    return request<NewsArticlesResponse>(`/api/news/articles${qs ? `?${qs}` : ''}`);
  },

  markNewsArticleRead: (id: string, read: boolean) =>
    request<{ ok: true }>(`/api/news/articles/${id}/read`, { method: 'POST', body: JSON.stringify({ read }) }),

  markAllNewsRead: (opts?: { feedId?: string; folder?: string | null }) =>
    request<{ ok: true; marked: number }>('/api/news/read-all', {
      method: 'POST',
      body: JSON.stringify({ feed_id: opts?.feedId ?? null, folder: opts?.folder ?? null }),
    }),

  saveNewsArticle: (id: string) => request<NewsSavedArticle>(`/api/news/articles/${id}/save`, { method: 'POST' }),

  listNewsSaved: () => request<NewsSavedArticle[]>('/api/news/saved'),

  deleteNewsSaved: (id: string) => request<{ ok: true }>(`/api/news/saved/${id}`, { method: 'DELETE' }),

  // ---- Bets (sports betting dashboard) ----

  listBets: () => request<Bet[]>('/api/bets'),

  createBet: (params: {
    date: string;
    sport: string;
    sportsbook: string;
    bet_type: string;
    pick?: string;
    odds: number;
    wager: number;
    result: string;
    manual_profit?: number | null;
    notes?: string;
    legs?: Omit<BetLeg, 'id' | 'bet_id' | 'position' | 'created_at'>[];
  }) => request<Bet>('/api/bets', { method: 'POST', body: JSON.stringify(params) }),

  updateBet: (id: string, params: Partial<Omit<Bet, 'legs'>> & { legs?: Omit<BetLeg, 'id' | 'bet_id' | 'position' | 'created_at'>[] }) =>
    request<Bet>(`/api/bets/${id}`, { method: 'PATCH', body: JSON.stringify(params) }),

  deleteBet: (id: string) => request<{ ok: true }>(`/api/bets/${id}`, { method: 'DELETE' }),

  // ---- Auth (app-wide lock screen — 0033_auth.sql) ----

  authStatus: () => request<AuthStatus>('/api/auth/status'),

  webauthnRegisterOptions: (device_label: string) =>
    request<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/webauthn/register/options', {
      method: 'POST',
      body: JSON.stringify({ device_label }),
    }),

  webauthnRegisterVerify: (device_label: string, challenge: string, response: RegistrationResponseJSON) =>
    request<{ ok: true; backup_code: string | null }>('/api/auth/webauthn/register/verify', {
      method: 'POST',
      body: JSON.stringify({ device_label, challenge, response }),
    }),

  webauthnLoginOptions: () => request<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/webauthn/login/options', { method: 'POST' }),

  webauthnLoginVerify: (challenge: string, response: AuthenticationResponseJSON) =>
    request<{ ok: true }>('/api/auth/webauthn/login/verify', { method: 'POST', body: JSON.stringify({ challenge, response }) }),

  pinSetup: (pin: string) => request<{ ok: true; backup_code: string | null }>('/api/auth/pin/setup', { method: 'POST', body: JSON.stringify({ pin }) }),

  pinLogin: (pin: string) => request<{ ok: true }>('/api/auth/pin/login', { method: 'POST', body: JSON.stringify({ pin }) }),

  redeemBackupCode: (code: string) => request<{ ok: true; backup_code: string }>('/api/auth/backup-code/redeem', { method: 'POST', body: JSON.stringify({ code }) }),

  regenerateBackupCode: () => request<{ backup_code: string }>('/api/auth/backup-code/regenerate', { method: 'POST' }),

  listAuthCredentials: () => request<AuthCredentialSummary[]>('/api/auth/credentials'),

  deleteAuthCredential: (id: string) => request<{ ok: true }>(`/api/auth/credentials/${id}`, { method: 'DELETE' }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  // ---- Vault (0034_vault.sql, superseded by 0036_vault_facts.sql for the
  // structured-fields part — see that migration and api/types.ts) ----

  listVaultEntries: () => request<Entity[]>('/api/vault/entries'),

  getVaultEntry: (id: string) => request<VaultEntryDetail>(`/api/vault/entries/${id}`),

  createVaultEntry: (params: { title?: string } = {}) =>
    request<Entity>('/api/vault/entries', { method: 'POST', body: JSON.stringify(params) }),

  updateVaultEntry: (id: string, patch: { title?: string; content?: string | null; pinned?: boolean }) =>
    request<Entity>(`/api/vault/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteVaultEntry: (id: string) => request<{ ok: true }>(`/api/vault/entries/${id}`, { method: 'DELETE' }),

  addVaultFact: (entryId: string, label: string, value: string | null) =>
    request<VaultFact>(`/api/vault/entries/${entryId}/facts`, { method: 'POST', body: JSON.stringify({ label, value }) }),

  updateVaultFact: (id: string, patch: { label?: string; value?: string | null }) =>
    request<VaultFact>(`/api/vault/facts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteVaultFact: (id: string) => request<{ ok: true }>(`/api/vault/facts/${id}`, { method: 'DELETE' }),

  reorderVaultFacts: (entryId: string, ordered_ids: string[]) =>
    request<{ ok: true }>(`/api/vault/entries/${entryId}/facts/reorder`, { method: 'POST', body: JSON.stringify({ ordered_ids }) }),

  getVaultRollup: () => request<VaultRollupGroup[]>('/api/vault/facts/rollup'),

  getVaultFactLabels: () => request<VaultFactLabel[]>('/api/vault/facts/labels'),
};
