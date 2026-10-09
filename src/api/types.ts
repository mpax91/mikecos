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
  /** Set by Statements: 'live' = kept current nightly (e.g. Latest
   * Statement); 'once' = added automatically once, Mike's to edit. */
  auto?: 'live' | 'once';
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
  /** A note/file's expiration date ('YYYY-MM-DD') — insurance card,
   * registration, inspection sticker, a warranty doc, anything with a
   * renewal date. Setting it auto-creates a real task due 30 days out
   * (see worker/migrations/0039_entity_expiration.sql), which shows up in
   * Today on its own; the frontend only ever needs to read/write this
   * field, never expiry_task_id. */
  archived_at?: string | null; // set while a project/list is archived (status 'archived')
  expires_at: string | null;
  waiting_source_id?: string | null; // Waiting For check-back task: the handed-off task (migration 0095)
  waiting_since?: string | null;
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
  /** A Vault Password card is stored as type='note' with this flag set, not
   * a distinct type (see worker/migrations/0041_vault_passwords.sql, same
   * trick as is_jot/is_list). */
  is_password?: number;
  /** Only present when is_password is set — attached by GET
   * /api/entities/:id from the sibling vault_credentials table. Never
   * present on any other entity. */
  url?: string | null;
  username?: string | null;
  password?: string | null;
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
  /** First few open item titles, in list order — lets the card render an
   * actual checklist preview instead of just a count. */
  preview_items: string[];
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
  /** Auto-Pay bills due this day (Bills & Due Dates) — shown, never checkable. */
  autopayBills?: AutopayBill[];
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
  /** Auto-Pay bills due this day (Bills & Due Dates). */
  autopayBills?: AutopayBill[];
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
  autopayBills?: AutopayBill[];
}

/** An Auto-Pay bill on the Calendar (Bills & Due Dates): no task, no
 * checkbox — just a marker on its due date. */
export interface AutopayBill {
  billId: string;
  date: string;
  name: string;
  amount: number | null;
  entryId: string | null;
}

/** A row in Settings → Bills & Due Dates (GET /api/bills). */
export interface Bill {
  id: string;
  source: 'statement' | 'manual';
  name: string;
  entryId: string | null;
  folderId: string | null;
  enabled: boolean;
  dueDay: number | null;
  dueDayLabel: string | null;
  autoDueDay: number | null;
  dueEdited: boolean;
  autopay: boolean;
  autoAutopay: boolean | null;
  autopayEdited: boolean;
  amount: number | null;
  latest: { amount: number; dueDate: string | null } | null;
  nextDue: string | null;
  openTask: { id: string; title: string; dueDate: string | null } | null;
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

// ---- Bookmarks — a periodic, manual mirror of a Chrome bookmarks export
// (see worker/migrations/0060_bookmarks.sql). `url` is null for a folder
// node. Every import fully replaces the tree; `lastImportedAt` is when
// that last happened. ----

export interface BookmarkNode {
  id: string;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  children: BookmarkNode[];
}

export interface BookmarksResponse {
  nodes: BookmarkNode[];
  linkCount: number;
  folderCount: number;
  lastImportedAt: string | null;
}

export interface BookmarksImportResult {
  folderCount: number;
  linkCount: number;
  importedAt: string;
}

// ---- Cloud — a live, Windows-Explorer-style view over connected cloud
// storage accounts (see worker/migrations/0061_cloud_storage.sql and
// worker/src/cloudProviders/*.ts). Nothing here is cached in D1 beyond the
// account connection itself and its quota snapshot: every browse/search
// call reflects the provider's real, current state. ----

export type CloudProviderId = 'google_drive' | 'onedrive' | 'dropbox' | 'box';

export interface CloudProviderInfo {
  id: CloudProviderId;
  label: string;
  configured: boolean; // whether an OAuth app has been registered for this provider yet
  connectedCount: number;
}

export interface CloudQuota {
  usedBytes: number;
  totalBytes: number | null; // null = unlimited/unreported
  checkedAt: string;
}

export interface CloudAccount {
  id: string;
  provider: CloudProviderId;
  providerLabel: string;
  label: string; // Mike's own name for the account, e.g. "Personal"
  accountEmail: string | null;
  icon: string;
  color: string;
  position: number;
  status: 'connected' | 'error';
  lastError: string | null;
  quota: CloudQuota | null;
}

export interface CloudFileEntry {
  id: string; // opaque — pass back verbatim as folderId/fileId, never parse it
  name: string;
  type: 'folder' | 'file';
  sizeBytes: number | null;
  modifiedAt: string | null;
  mimeType: string | null;
  webUrl: string | null; // provider's own "open" link, for View
}

export interface CloudBrowseResponse {
  entries: CloudFileEntry[];
}

export interface CloudSearchHit extends CloudFileEntry {
  path: string | null;
  accountId: string;
  accountLabel: string;
  provider: CloudProviderId;
}

export interface CloudSearchResponse {
  results: CloudSearchHit[];
}

// ---- Wallet (loyalty/membership/pass/gift cards — see
// worker/migrations/0045_wallet.sql for why this is its own flat table) ----

export type WalletBarcodeType = 'code128' | 'qr' | 'upc' | 'ean13' | 'none';

export interface WalletCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface WalletCard {
  id: string;
  name: string;
  category: string;
  barcodeType: WalletBarcodeType;
  barcodeValue: string | null;
  displayNumber: string | null;
  pinCode: string | null;
  balance: string | null;
  notes: string | null;
  color: string | null;
  coverArtKey: string | null;
  coverArtUrl: string | null;
  backArtKey: string | null;
  backArtUrl: string | null;
  /** Detected independently per side from each uploaded photo's own pixel
   * dimensions (see WalletCardEditor) — 'landscape' is the default and the
   * common case (a real physical card's own proportions); 'portrait' is
   * the rare vertical path that sizes that side's art box the other way
   * instead of cropping it. Front and back can genuinely differ (a card
   * with a vertical front and horizontal back). Never a choice Mike makes
   * by hand. */
  coverArtOrientation: 'landscape' | 'portrait';
  backArtOrientation: 'landscape' | 'portrait';
  pinned: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Never the actual license/passport/military-ID number — only whether
   * one is on file. The real value comes from api.revealWalletCardId(),
   * fetched on an explicit tap. Same pattern as PaymentCard's hasNumber. */
  hasIdNumber: boolean;
}

export interface WalletCardIdSecret {
  idNumber: string | null;
}

/** A structured "Details" row on a Wallet card — expiration date, member
 * ID #, anything worth a labeled field rather than a line of Notes prose.
 * Same table shape as VaultFact (see worker/migrations/0048_wallet_card_
 * facts.sql and wallet.ts's factJson) on purpose: `entry_id` here is
 * actually the card id, kept under that name so the same VaultFactsTable
 * component works unmodified for both. */
export interface WalletCardFact {
  id: string;
  entry_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

// Same shape and same "entry_id is actually the card id" trick as
// WalletCardFact above (see worker/migrations/0050_payment_card_facts.sql
// and paymentCards.ts's factJson) — kept as its own type rather than
// reused so Payment Cards' facts stay a distinct concept from Wallet's,
// even though the wire shape happens to match.
export interface PaymentCardFact {
  id: string;
  entry_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

// ---- Rewards (credit-card rewards optimizer — Wallet Phase 2. See
// worker/migrations/0047_rewards.sql for why this is a separate table
// family from wallet_cards above.) ----

export type RewardsBonusKind = 'fixed' | 'rotating';

export interface RewardsBonus {
  id: string;
  cardId: string;
  category: string;
  rate: number;
  kind: RewardsBonusKind;
  startsOn: string | null;
  endsOn: string | null;
  /** Optional comma-separated merchant/search aliases (e.g. "amazon, rhoback, etsy")
   * so Find can match a merchant name that shares no text with the category itself. */
  keywords: string | null;
  /** True for a category that only applies to online purchases (Amazon.com,
   * "Online Shopping", Chase Travel's own portal) — the physical card doesn't
   * need to be in the wallet for these, so they never earn a card a spot on
   * their own in "Carry in your wallet"; Find still surfaces them under its
   * "if this is an online purchase" callout. */
  onlineOnly: boolean;
  /** True when Mike has said he won't actually use this rotating bonus's
   * category this cycle (Discover it's Entertainment bonus, say) — it
   * still counts everywhere else (Find, the category table, "All reward
   * cards"), it just never earns the card a spot in "Carry in your
   * wallet" on its own. */
  excludeFromCarry: boolean;
  sortOrder: number;
}

export interface RewardsPerk {
  id: string;
  cardId: string;
  label: string;
  description: string | null;
  /** Free text spend category this perk applies to (e.g. "Car Rental",
   * "Phone/Wireless") — matched the same substring way as a bonus's own
   * category, so Find can surface "use this card, it has rental car
   * insurance" even with no cashback category involved. Null for a perk
   * with no natural spend category (an intro APR, purchase protection
   * that applies everywhere). */
  category: string | null;
  sortOrder: number;
}

/** A name/alias -> spend category directory (0058_rewards_merchant_intelligence.sql)
 * — what lets Find understand "Rhoback" means Online Shopping or "Fios"
 * means Phone/Wireless without Mike typing keywords onto every bonus
 * himself. */
export interface RewardsMerchant {
  id: string;
  name: string;
  aliases: string | null;
  category: string;
  notes: string | null;
}

/** A personalized, time-limited bank-portal deal (Chase Offers, Amex
 * Offers, Discover Deals) — manually noted, since these sit behind Mike's
 * own login and no research project can discover them. */
export interface RewardsOffer {
  id: string;
  cardId: string;
  merchant: string;
  description: string;
  expiresOn: string | null;
}

export interface RewardsCard {
  id: string;
  nickname: string;
  network: string | null;
  last4: string | null;
  baseRate: number;
  annualFee: number | null;
  alwaysCarry: boolean;
  active: boolean;
  color: string | null;
  coverArtKey: string | null;
  coverArtUrl: string | null;
  notes: string | null;
  sortOrder: number;
  /** Ties this card to the quarterly research-import workflow (see
   * worker/migrations/0057_rewards_import.sql) — null for a card Mike
   * added by hand, which an import never touches. */
  importKey: string | null;
  createdAt: string;
  updatedAt: string;
  bonuses: RewardsBonus[];
  perks: RewardsPerk[];
  offers: RewardsOffer[];
}

export interface RewardsImportResult {
  created: number;
  updated: number;
  /** Of `updated`, how many were actually a keyless card Mike had entered
   * by hand before this import existed for it — matched by nickname on
   * this first run and linked to the new importKey, rather than creating
   * a duplicate. Purely informational. */
  adopted: number;
  bonusesWritten: number;
  perksWritten: number;
  merchantsWritten: number;
  errors: string[];
  unmatchedExisting: { nickname: string; importKey: string }[];
}

// ---- Payment Cards (Wallet Phase 3 — a secure credit/debit card vault.
// See worker/migrations/0049_payment_cards.sql for the schema and the
// linking-not-duplicating design with RewardsCard above.) ----

export type PaymentCardType = 'credit' | 'debit' | 'bank';
export type BankAccountKind = 'checking' | 'savings' | 'money_market' | 'cd' | 'other';

/** A Wallet bank account's live balance, matched by last 4 to an account
 * on a live Statements folder's latest statement. */
export interface StatementAccountLink {
  folderId: string;
  folderNickname: string;
  institution: string | null;
  kind: string | null;
  product: string | null;
  owners: string | null;
  balance: number;
  asOf: string;
  apy: number | null;
}

export interface BankAccountSuggestion extends StatementAccountLink {
  last4: string;
}

export interface PaymentCard {
  id: string;
  nickname: string;
  cardType: PaymentCardType;
  network: string | null;
  issuer: string | null;
  last4: string | null;
  nameOnCard: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  /** Never the actual number — only whether one is on file. The real value
   * comes from api.revealPaymentCard(), fetched on an explicit tap. */
  hasNumber: boolean;
  hasCvv: boolean;
  hasPin: boolean;
  billingZip: string | null;
  color: string | null;
  coverArtKey: string | null;
  coverArtUrl: string | null;
  backArtKey: string | null;
  backArtUrl: string | null;
  notes: string | null;
  rewardWorthy: boolean;
  rewardsCardId: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Bank accounts (cardType 'bank') only. */
  accountKind: BankAccountKind | null;
  routingNumber: string | null;
  wireRoutingNumber: string | null;
  accountOwners: string | null;
  statementAccount: StatementAccountLink | null;
}

export interface PaymentCardSecrets {
  number: string | null;
  cvv: string | null;
  pin: string | null;
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
  /** voter_file + mode: 'replace' only — what committing it will delete
   * before writing the new file's rows. */
  replacing?: { voterRecordCount: number; voterOnlyContactCount: number };
  /** contacts + mode: 'replace' only — previously-imported contacts (source
   * = 'contact_import') this file doesn't mention at all, by name, so
   * Settings can show exactly who before deleting them. Pass their ids back
   * as deleteContactIds on commit/start to actually remove them. */
  replacingContacts?: { id: string; name: string }[];
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

// Re-parses already-imported voter_records rows' stored raw_data with the
// current field mapping — see worker/migrations/0022_voter_record_fields.sql
// and worker/src/index.ts's POST /api/contacts/voter-fields/backfill-chunk.
// Also fills in the linked contact's city (or birthday/address) when still
// blank. No preview step (unlike name cleanup) — this only ever fills in
// blanks, never changes an existing value, so there's nothing to review
// first.
export interface VoterFieldsBackfillChunkResponse {
  processed: number;
  updated: number;
  nextCursor: string | null;
  done: boolean;
}

// Contacts "Ask" — rule-based natural-language query over contacts + voter
// data (see worker/src/contactsAssistant.ts for the matching rules).
export interface ContactAskResultEntry {
  id: string;
  name: string;
  city: string | null;
  circle: ContactCircle;
  party: string | null;
  voterAge: number | null;
}

export interface ContactAskResponse {
  understood: string[]; // e.g. ["city: Bedford", "party: Republicans", "age: under 25"] — empty when nothing was recognized
  summary: string; // e.g. "You have 79 Republicans under 25 in Bedford."
  count: number;
  contacts: ContactAskResultEntry[];
}

// Bets Workspace handicapping enrichment (see worker/src/betsEnrichment.ts)
// — weather, injuries, and team form pulled from ESPN's free public data,
// no key or paid odds feed involved. Every field is nullable/optional
// because a sport, date, or single stat ESPN doesn't have just comes back
// empty rather than erroring.
export interface BetGameInjury {
  player: string;
  position: string | null;
  status: string;
  detail: string | null;
}

export interface BetGameTopPerformer {
  category: string;
  player: string;
  stat: string;
}

export interface BetGameProbablePitcher {
  name: string;
  throws: string | null; // 'L' | 'R'
  wins: string | null;
  losses: string | null;
  era: string | null;
  strikeouts: string | null;
}

export interface BetGameProbableGoalie {
  name: string;
  gaa: string | null;
  savePct: string | null;
  wins: string | null;
  losses: string | null;
}

export interface BetGameRecentGame {
  date: string | null;
  opponent: string | null;
  atVs: string | null; // '@' | 'vs'
  result: 'W' | 'L' | null;
  score: string | null;
}

export interface BetGameTeamSnapshot {
  abbreviation: string;
  displayName: string;
  record: { overall: string | null; home: string | null; road: string | null };
  avgPointsFor: number | null;
  avgPointsAgainst: number | null;
  injuries: BetGameInjury[]; // already filtered server-side to game-time-decision-ish statuses — see betsEnrichment.ts
  topPerformers: BetGameTopPerformer[];
  probablePitcher: BetGameProbablePitcher | null; // MLB only
  probableGoalie: BetGameProbableGoalie | null; // NHL only
  recentForm: { record: string | null; games: BetGameRecentGame[] }; // straight W/L, most recent first
}

// Open vs current — ESPN's odds partner (DraftKings in every sample seen)
// exposes both, not just a single live snapshot.
export interface BetGameOddsSide {
  open: number | null;
  current: number | null;
}

// Spread shows the price (the vig for taking that side, e.g. -110) instead
// of the open line — Mike's own call, since the open line read as a
// confusing near-duplicate of the current line.
export interface BetGameOddsSpreadSide {
  current: number | null;
  price: number | null;
}

export interface BetGameOdds {
  provider: string | null; // e.g. "DraftKings"
  spread: { home: BetGameOddsSpreadSide; away: BetGameOddsSpreadSide } | null;
  total: { open: number | null; current: number | null; overOdds: number | null; underOdds: number | null } | null;
  moneyline: { home: BetGameOddsSide; away: BetGameOddsSide } | null;
}

export interface BetGameMatchupMeeting {
  date: string | null;
  homeAbbr: string | null;
  awayAbbr: string | null;
  homeScore: string | null;
  awayScore: string | null;
  winnerAbbr: string | null;
}

export interface BetGameMatchupHistory {
  series: { type: string; summary: string | null }[]; // 'season' | 'current' | 'preseason'
  recentMeetings: BetGameMatchupMeeting[]; // up to 5, most recent first
}

// ESPN's own model-based win probability — a free, real number, but a model
// projection, not a human tipster's pick. Surface it labeled that way.
export interface BetGamePredictor {
  homeWinPct: number | null;
  awayWinPct: number | null;
}

export interface BetGameEnrichment {
  found: boolean;
  venue: { name: string | null; city: string | null; state: string | null; indoor: boolean } | null;
  weather: { temperature: number | null; precipitationChance: number | null; windGust: number | null; indoor: boolean } | null;
  odds: BetGameOdds | null;
  matchupHistory: BetGameMatchupHistory | null;
  predictor: BetGamePredictor | null;
  home: BetGameTeamSnapshot | null;
  away: BetGameTeamSnapshot | null;
  note: string | null; // set when nothing could be resolved, so the UI can say why
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

export type HabitDirection = 'build' | 'reduce';

/** A habit is quantified rather than plain done/not-done — `unit`/
 * `target_value` are both optional, so a simple habit just logs 1 (or any
 * number) per day with no target shown. `log` is this specific day's value,
 * attached only on GET /api/journal/:date's habit list — null means nothing
 * logged for that habit on that day yet. `direction` says which way is
 * winning ('reduce' for a habit you're cutting down, like counting
 * something down day over day — 'build' for everything else, the default),
 * and drives the wording/coloring of every comparison shown for it. */
export interface Habit {
  id: string;
  name: string;
  unit: string | null;
  target_value: number | null;
  direction: HabitDirection;
  icon: string | null;
  active: number; // 0 | 1
  position: number;
  created_at: string;
  updated_at: string;
  log?: HabitLog | null;
}

/** One precise, timestamped occurrence — the unit the Habits capture page
 * logs (a single tap), as opposed to HabitLog's one-total-per-day. */
export interface HabitEvent {
  id: string;
  habit_id: string;
  occurred_at: string; // ISO instant
  date: string; // 'YYYY-MM-DD', local
  value: number;
  created_at: string;
}

export interface HabitDaySeries {
  date: string;
  total: number;
}

/** Everything the Habits page, Dashboard card, and Stats section need for
 * one habit, computed live server-side from journal_habit_events — see
 * GET /api/habits/summary. */
export interface HabitSummary {
  habit: Habit;
  today: number;
  yesterday: number;
  todayLogged: boolean;
  yesterdayLogged: boolean;
  avg7: number;
  avg30: number;
  best: number | null;
  series: HabitDaySeries[]; // last 14 days, oldest first, zero-filled
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

// One row per monthly credit-score check-in — mirrors worker/src/types.ts's
// CreditScoreEntry. See worker/migrations/0042_credit_score.sql for the
// full rationale (CreditSesame/Discover-Fico are historical-only; average
// is computed client-side from whichever columns are non-null).
export interface CreditScoreEntry {
  entry_date: string; // 'YYYY-MM-DD'
  creditkarma: number | null; // round(avg(creditkarma_transunion, creditkarma_equifax)) going forward
  creditkarma_transunion: number | null;
  creditkarma_equifax: number | null;
  creditsesame: number | null;
  discover_fico: number | null;
  creditwise: number | null;
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

/** One folder name currently in use across news_feeds, plus its Settings-
 * managed sort position (see worker/migrations/0064_news_folders.sql).
 * sortOrder is null until Mike has explicitly reordered folders at least
 * once — those sort alphabetically, after every folder that does have a
 * position. */
export interface NewsFolder {
  name: string;
  sortOrder: number | null;
}

/** GET /api/news/feeds' response shape. totalUnread and folderUnread are
 * server-computed distinct-article counts — a story 0065_news_article_feeds
 * links to more than one feed (a publisher's own overlapping category
 * feeds) must not be double-counted the way summing each feed's own
 * unread_count client-side would; each feed's own unread_count on the
 * NewsFeed rows themselves stays accurate as-is. folderUnread is keyed by
 * folder name, with '' for Uncategorized (folder null), matching the
 * convention the rest of News' API already uses for that. */
export interface NewsFeedsResponse {
  feeds: NewsFeed[];
  totalUnread: number;
  folderUnread: Record<string, number>;
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

export type SearchGroupKey = 'notes' | 'jots' | 'lists' | 'projects' | 'vault' | 'wallet' | 'rewards' | 'payment_cards' | 'boards' | 'contacts' | 'journal' | 'meeting_notes' | 'links' | 'media';

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
  type: 'birthday' | 'anniversary' | 'card_expiry';
  contactId?: string;
  cardId?: string;
  name: string;
  inDays: number;
}

export interface BriefingTaskRef {
  id: string;
  title: string;
}

export interface BriefingMissingEpisode {
  id: string;
  show_title: string;
  season_number: number;
  episode_number: number;
  episode_name: string | null;
  aired_on: string;
}

export interface BriefingInsights {
  overdueCount: number;
  overdueTasks: (BriefingTaskRef & { due_date: string })[];
  dueTodayCount: number;
  dueTodayTasks: BriefingTaskRef[];
  upcomingDates: BriefingUpcomingDate[];
  staleProjects: (BriefingTaskRef & { last_touched: string })[];
  missingEpisodes: BriefingMissingEpisode[];
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

// The base four are still what computeProfit/computeStreaks/etc. in
// utils/bets.ts pattern-match on, but the set itself is now Settings-
// editable (0084_bet_options_tipper_line.sql added 'cashed_out'/'tbd'),
// so this is intentionally just `string` rather than a closed union.
export type BetResult = string;

// Only ever non-empty when bet_type is 'Parlay' | 'SGP' |
// 'SGPx' — see worker/migrations/0038_bet_legs.sql for the money-vs-
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

export type BetStakeType = 'cash' | 'free_bet';

export const BET_STAKE_TYPES: { value: BetStakeType; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'free_bet', label: 'Free bet / bonus bet' },
];

export interface Bet {
  id: string;
  date: string; // 'YYYY-MM-DD'
  sport: string;
  sportsbook: string;
  bet_type: string;
  pick: string | null; // deprecated — see worker/migrations/0084_bet_options_tipper_line.sql; new bets use `line` instead
  odds: number; // American odds
  wager: number;
  result: BetResult;
  stake_type: BetStakeType; // 'cash' (default) | 'free_bet' — see worker/migrations/0080_bet_stake_type.sql
  manual_profit: number | null;
  notes: string | null;
  tipper: string | null; // free text, who the pick came from — see 0084_bet_options_tipper_line.sql
  line: string | null; // 'ATS' | 'Mixed' | 'ML' | 'o/u' by default, Settings-editable
  legs: BetLeg[];
  created_at: string;
  updated_at: string;
}

// ---- Bets Settings: editable option lists (0084_bet_options_tipper_line.sql) ----

export type BetOptionCategory = 'bet_type' | 'tipper' | 'line' | 'result';

export interface BetOption {
  id: string;
  category: BetOptionCategory;
  value: string;
  label: string;
  position: number;
  created_at: string;
}

// ---- Bets banking/promos/workspace (0040_bet_workspace.sql) ----

export type BetTransactionType = 'deposit' | 'withdrawal' | 'bonus' | 'adjustment';

export const BET_TRANSACTION_TYPES: { value: BetTransactionType; label: string }[] = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'withdrawal', label: 'Withdrawal' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'adjustment', label: 'Adjustment' },
];

export interface BetTransaction {
  id: string;
  date: string;
  sportsbook: string;
  type: BetTransactionType;
  amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type BetPromoStatus = 'active' | 'used' | 'expired';

export interface BetPromo {
  id: string;
  sportsbook: string;
  sport: string | null; // null = usable on any sport (0088_bet_promo_sport.sql)
  description: string;
  promo_type: string;
  expires_at: string | null;
  legs: string | null;
  odds: string | null;
  amount: string | null;
  max_bonus: number | null; // shown as "Max Bet" — the max wager the promo applies to
  status: BetPromoStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BetGameLine {
  id: string;
  game_note_id: string;
  sportsbook: string;
  line: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface BetGameNote {
  id: string;
  date: string;
  sport: string;
  external_id: string | null;
  matchup: string;
  start_time: string | null;
  note: string | null;
  pinned: number;
  lines: BetGameLine[];
  created_at: string;
  updated_at: string;
}

/** A game pulled live from GET /api/bets/games (ESPN's public schedule
 * feed, no key) — not yet necessarily backed by a BetGameNote row; the
 * Workspace tab merges these with saved notes by (sport, external_id). */
export interface BetScheduleGame {
  sport: string;
  external_id: string;
  home_abbr: string;
  away_abbr: string;
  home_name?: string; // full team name, when the source has it cheaply — used in the game-detail panel only
  away_name?: string;
  matchup: string; // already abbreviated, e.g. 'WSH @ DET' — see worker's fetchEspn/fetchMlb/fetchNhl
  start_time: string;
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
  // Auto-detected from the value server-side (a date, a "$" amount) —
  // never user-set. See detectFactValue in worker/src/vault.ts.
  value_type?: 'date' | 'currency' | null;
  value_norm?: string | null;
  // 'pay:*' = an auto-updating payment fact (worker/src/accountPayers.ts);
  // NULL = Mike's own fact.
  managed_key?: string | null;
}

export interface VaultEntryDetail extends Entity {
  facts: VaultFact[];
}

export interface VaultRollupEntry {
  factId: string;
  entryId: string;
  entryTitle: string;
  value: string | null;
  valueType?: 'date' | 'currency' | null;
  valueNorm?: string | null;
}

export interface VaultRollupGroup {
  label: string;
  count: number;
  entries: VaultRollupEntry[];
}

// Lightweight sibling of VaultRollupGroup (no entries) for ghost-text
// autocomplete and the promoted-filter threshold — see GET
// /api/vault/facts/labels.
export interface VaultFactLabel {
  label: string;
  count: number;
}

// ---- Plex library mirror (worker/migrations/0051_plex.sql) — a synced
// copy of Mike's Plex catalogue: browsable, flagged for metadata gaps,
// and cross-checked against TVMaze for aired-but-missing episodes. ----

export type PlexLibraryType = 'movie' | 'show' | 'artist' | 'photo' | string;
export type PlexItemType = 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track' | 'item';

export interface PlexLibrary {
  id: string;
  title: string;
  libraryType: PlexLibraryType;
  itemCount: number;
  syncedAt: string | null;
}

export interface PlexItem {
  id: string;
  libraryId: string;
  parentId: string | null;
  type: PlexItemType;
  title: string;
  sortTitle: string | null;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  matched: boolean;
  summary: string | null;
  genres: string[];
  studio: string | null;
  thumbUrl: string | null;
  filePath: string | null;
  durationMs: number | null;
  addedAt: string | null;
  plexUpdatedAt: string | null;
}

export interface PlexItemDetail extends PlexItem {
  breadcrumb: { id: string; title: string }[];
}

export interface PlexIssue {
  id: string;
  title: string;
  type: PlexItemType;
  issues: string[];
}

export interface PlexMissingEpisode {
  id: string;
  showItemId: string;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeName: string | null;
  airedOn: string;
  detectedAt: string;
  dismissed: boolean;
}

// The hand-entered physical/digital catalog — see worker/migrations/
// 0073_media_catalog.sql and worker/src/mediaCatalog.ts. Deliberately just
// a catalog (title/author/format/notes), no read/listened status.
export type MediaCatalogFormat = 'physical_book' | 'ebook' | 'audiobook';
export type MediaSource = 'plex' | 'physical' | 'digital';

export interface MediaCatalogItem {
  id: string;
  title: string;
  author: string | null;
  format: MediaCatalogFormat;
  source: 'physical' | 'digital'; // derived from format — see sourceForFormat in mediaCatalog.ts
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlexSyncResult {
  libraries: { id: string; title: string; itemCount: number }[];
  totalItems: number;
}

// ---- The Bar (worker/migrations/0075_bar.sql) — home spirits/wine/beer
// inventory plus a Vivino/Untappd-style tasting log. See that migration's
// comment for why bar_items and bar_tastings are separate tables.

export type BarItemType = 'spirit' | 'wine' | 'beer';

export interface BarItem {
  id: string;
  type: BarItemType;
  name: string;
  category: string | null; // spirit: base spirit; wine: "Type" (appellation/varietal); beer: style — all now locked dropdowns
  producer: string | null;
  vintage: number | null;
  /** Deprecated — superseded by `geo` (country-level) below. Kept so old
   * rows' data isn't lost, but no longer shown or edited in the UI. */
  region: string | null;
  color: string | null; // wine only: Red/White/Rosé/Sparkling/Orange
  geo: string | null;   // wine only: country of origin, e.g. Italy/France/USA
  quantity: number;
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  notes: string | null;
  price: number | null;
  source: string | null; // a store name, or "Gift"
  photoKey: string | null;
  photoOrientation: 'landscape' | 'portrait';
  createdAt: string;
  updatedAt: string;
}

export interface BarItemDetail extends BarItem {
  tastings: BarTasting[];
}

export interface BarTasting {
  id: string;
  itemId: string;
  consumedAt: string | null;
  score: number | null; // 0.5-5.0 in 0.5 steps
  tags: string[];
  notes: string | null;
  buyAgain: boolean | null;
  createdAt: string;
}

export interface BarTopTastingEntry extends BarTasting {
  item: {
    id: string;
    name: string;
    type: BarItemType;
    category: string | null;
    producer: string | null;
    vintage: number | null;
    region: string | null;
    color: string | null;
    geo: string | null;
    quantity: number;
  };
}

// One bounded chunk of the sync — a large library takes several of these
// (see worker/src/plexSync.ts's header comment on why it's chunked at
// all). The caller keeps calling the endpoint until `done` is true.
export interface PlexSyncChunkResult {
  done: boolean;
  progress: { library: string | null; librariesCompleted: number; librariesTotal: number; itemsSoFar: number };
  summary?: PlexSyncResult;
}

// One bounded chunk of the nightly Airing check (see
// worker/src/plexAiring.ts's header comment above runAiringCheckChunk for
// why this is chunked — a large library's first cold TVMaze-resolve pass
// alone can exceed a single request). Same polling shape as
// PlexSyncChunkResult: the caller keeps calling the endpoint until `done`.
export interface PlexAiringCheckChunkResult {
  done: boolean;
  progress: { phase: string; showsResolved: number; newlyFlagged: number };
  summary?: { showsResolved: number; newlyFlagged: number };
}

// ---- Home: a to-scale digital floor plan (0077_home.sql). Every
// dimension (room width/depth, fixture footprint, x/y position) is in
// whole inches — the canvas draws everything proportionally, so a
// fixture's footprint really is to scale against the room it's in. A
// fixture's x/y is relative to its own room's top-left corner, not the
// floor, so dragging a room carries its fixtures with it for free. ----

export interface HomeFloor {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface HomePoint {
  x: number;
  y: number;
}

export interface HomeRoom {
  id: string;
  floorId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  points: HomePoint[]; // the room's real shape — polygon in inches, relative to (x,y)'s bounding box. Rectilinear when drawn on the canvas; may have angled walls/curves when imported from a spec. See src/lib/homeGeometry.ts, src/lib/roomSpec.ts.
  ceilingHeight: number | null; // inches
  spec: string | null; // JSON room spec it was imported from — null once reshaped on the canvas
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HomeWallItemType = 'door' | 'window';

/** What the room-spec import/reshape endpoints take — the output of
 * solveRoomSpec (src/lib/roomSpec.ts). */
export interface HomeRoomSpecPayload {
  points: HomePoint[];
  ceilingHeight: number | null;
  spec: unknown;
  wallItems: { type: HomeWallItemType; label: string; wallIndex: number; offset: number; width: number; swing: 'left' | 'right' | null; notes: string | null }[];
}

export interface HomeWallItem {
  id: string;
  roomId: string;
  type: HomeWallItemType;
  label: string;
  wallIndex: number;
  offset: number;
  width: number;
  swing: 'left' | 'right' | null; // doors only
  vaultEntryId: string | null;
  vaultEntryTitle: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HomeFixtureType = 'appliance' | 'furniture' | 'outlet' | 'switch' | 'fixture';

export interface HomeFixture {
  id: string;
  roomId: string;
  type: HomeFixtureType;
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  vaultEntryId: string | null;
  vaultEntryTitle: string | null;
  breakerId: string | null;
  breakerNumber: string | null;
  breakerLabel: string | null;
  smartDevice: boolean;
  smartNotes: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HomeFloorLayout {
  floor: HomeFloor;
  rooms: HomeRoom[];
  fixtures: HomeFixture[];
  wallItems: HomeWallItem[];
}

export interface ElectricalPanel {
  id: string;
  name: string;
  locationNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ElectricalBreaker {
  id: string;
  panelId: string;
  number: string;
  label: string | null;
  amperage: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ElectricalBreakerWithFixtures extends ElectricalBreaker {
  fixtures: { id: string; label: string; type: HomeFixtureType; roomName: string; floorName: string }[];
}

// One bounded chunk of the manually-triggered full-history scan (see
// worker/src/plexAiring.ts's header comment above runFullHistoryScanChunk
// for why this one's chunked and the nightly check above isn't). The
// caller keeps calling the endpoint until `done` is true.
export interface PlexAiringScanChunkResult {
  done: boolean;
  progress: { showsScanned: number; showsTotal: number; newlyFlagged: number };
  summary?: { showsScanned: number; newlyFlagged: number };
}

// ---- Inbox — a live status board over real IMAP mailboxes, not a built-in
// mail client. See worker/migrations/0059_email_inbox.sql and
// worker/src/email.ts for the schema/sync-engine rationale.

export interface EmailAccount {
  id: string;
  label: string;
  email: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  icon: string;
  icon_image_key: string | null;
  iconImageUrl: string | null;
  color: string;
  position: number;
  active: number;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** An EmailAccount plus its unread/unprocessed counts, as returned by
 * GET /api/email/inbox — the account-tab strip's badge counts. */
export interface EmailAccountWithCounts extends EmailAccount {
  unreadCount: number;
  totalCount: number;
}

export interface EmailMessage {
  id: string;
  account_id: string;
  gm_msgid: string;
  gm_thrid: string | null;
  uid: number;
  message_id_header: string | null;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  snippet: string | null;
  received_at: string;
  is_read: number;
  in_inbox: number;
  processed_at: string | null;
  converted_to_entity_id: string | null;
  first_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface EmailInboxFeed {
  accounts: EmailAccountWithCounts[];
  // Everything still sitting in the mailbox's Inbox (not archived,
  // deleted, or converted) — no more New/Needs Processing split; a
  // message's `is_read` just controls how its row looks.
  items: EmailMessage[];
}

export interface EmailPeekResult extends EmailMessage {
  body: string;
  bodyHtml: string | null;
}

export interface EmailSyncResult {
  results: { id: string; ok: boolean; error?: string }[];
}

// ---- Statements (worker/src/statements/*, migration 0089) ----

export type StatementFolderStatus = 'live' | 'needs_template' | 'ignored';
export type AccountOwner = 'household' | 'chase';

export interface Ny529SettingsShape {
  nyLimit: number;
  limitConfirmedYear: number | null;
  projectionMode: 'auto' | 'fixed';
  projectionReturnPct: number;
}

export interface StatementFolder {
  id: string;
  accountId: string;
  folderId: string;
  folderName: string;
  folderUrl: string | null;
  templateId: string | null;
  templateName: string | null;
  nickname: string;
  status: StatementFolderStatus;
  owner: AccountOwner;
  vaultEntryId: string | null;
  settings: Ny529SettingsShape | null;
  lastScanAt: string | null;
  lastError: string | null;
  coverage: { total: number; parsed: number };
  lastPeriodEnd: string | null;
  openFlags: number;
}

export interface StatementDriveAccount {
  accountId: string;
  accountLabel: string;
  accountEmail: string | null;
  error: string | null;
  folders: {
    folderId: string;
    folderName: string;
    folderUrl: string | null;
    registered: StatementFolder | null;
    suggestedTemplateId: string | null;
    defaultIgnored: boolean;
  }[];
}

export interface StatementScanResult {
  listed: number;
  read: number;
  parsed: number;
  unreadable: number;
  duplicates: number;
  remaining: number;
  errors: string[];
}

export interface FinanceAccount extends StatementFolder {
  /** 'balance' accounts (529, savings) count toward totals; 'bill' accounts
   * (ADT, utilities) show their latest bill and monthly cost instead. */
  headline:
    | { kind: 'balance'; value: number; asOf: string | null; principal?: number; earnings?: number; parts?: { label: string; value: number }[] }
    | { kind: 'bill'; value: number; asOf: string | null; monthly: number | null; status: AdtBillStatus }
    /** Credit cards: the statement balance owed (a liability — not added to
     * the account total; summed as Card Balances). */
    | { kind: 'card'; value: number; asOf: string | null; status: CardStatus; dueDate: string | null; minimum: number | null; pointsValue: number | null }
    | null;
}

export type CardStatus = 'paid' | 'due' | 'past_due' | 'credit' | 'none';

export type AdtBillStatus = 'paid' | 'autopay' | 'due' | 'past_due' | 'credit' | 'none';

export interface StatementCheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AdtBill {
  invoiceDate: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  charges: number;
  taxes: number;
  billed: number;
  previousBalance: number;
  payments: number;
  totalDue: number;
  dueDate: string | null;
  dueNote: string | null;
  autopay: boolean;
  monthlyRate: number | null;
  services: string | null;
  fileId: string;
  checksOk: boolean;
  checks: StatementCheckRow[];
}

export interface AdtSummary {
  asOf: string | null;
  latest: AdtBill | null;
  monthlyRate: number | null;
  monthlyWithTax: number | null;
  rateSince: string | null;
  rateHistory: { from: string; to: string; rate: number; services: string | null; bills: number }[];
  years: { year: number; bills: number; billed: number; paid: number }[];
  ytdBilled: number;
  ytdBills: number;
  lifetimeBilled: number;
  lifetimePaid: number;
  firstInvoice: string | null;
  bills: AdtBill[];
  gaps: { after: string; before: string; days: number }[];
  pastDueBills: string[];
  nextBillExpected: string | null;
  status: AdtBillStatus;
}

export interface AdtDashboard {
  kind: 'adt';
  folder: StatementFolder;
  template: { nickname: string; institution: string; type: string; site?: string; phone?: string } | null;
  account: { accountLast: string } | null;
  summary: AdtSummary;
  statements: { id: string; periodEnd: string; fileId: string; checks: StatementCheckRow[] }[];
  transactions: { date: string; description: string; kind: string; amount: number }[];
  files: { fileId: string; name: string; url: string | null; status: string; error: string | null }[];
  flags: { id: string; severity: 'warn' | 'info'; message: string; created_at: string }[];
  payTask: { id: string; title: string; due: string | null; status: string | null } | null;
}

export type Ny529MonthState = 'deposited' | 'missed' | 'upcoming' | 'before_start' | 'unknown';

export interface Ny529Summary {
  asOf: string | null;
  value: number;
  principal: number;
  earnings: number;
  gainPct: number | null;
  portfolio: string | null;
  unitPrice: number | null;
  aip: { amount: number; day: number; startedOn: string } | null;
  aipChanges: { date: string; from: number; to: number }[];
  year: number;
  ytdContributions: number;
  ytdAsOf: string | null;
  remainingDrafts: number;
  projectedYearEnd: number;
  limit: number;
  gap: number;
  months: { month: string; state: Ny529MonthState; amount: number }[];
  missedMonths: string[];
  quarters: {
    periodStart: string;
    periodEnd: string;
    beginning: number;
    contributions: number;
    withdrawals: number;
    change: number;
    earnings: number;
    returnPct: number | null;
    ending: number;
    unitPrice: number | null;
    checksOk: boolean;
    fileId: string;
  }[];
  actualReturn: { since: string; years: number; cumulativePct: number; annualizedPct: number | null } | null;
  projection: {
    targetDate: string;
    value: number;
    contributed: number;
    returnPct: number;
    source: 'actual' | 'fallback' | 'fixed';
    actualFrom: string | null;
  } | null;
}

export interface Ny529Dashboard {
  kind?: 'ny529';
  folder: StatementFolder;
  account: { owner: string; beneficiary: string; accountLast: string; accountType: string } | null;
  template: { nickname: string; institution: string; type: string; site?: string; phone?: string } | null;
  summary: Ny529Summary;
  statements: { id: string; periodStart: string; periodEnd: string; fileId: string; checks: { name: string; ok: boolean; detail: string }[] }[];
  transactions: { date: string; description: string; kind: string; amount: number; units: number | null; unitPrice: number | null }[];
  files: { fileId: string; name: string; url: string | null; status: string; error: string | null }[];
  flags: { id: string; severity: 'warn' | 'info'; message: string; created_at: string }[];
  topupTask: { id: string; title: string; due: string | null; status: string | null } | null;
}

export type AllyAccountKind = 'checking' | 'savings' | 'other';

export interface AllyAccountSummary {
  last4: string;
  kind: AllyAccountKind;
  label: string;
  product: string | null;
  openDate: string | null;
  balance: number;
  apy: number | null;
  avgDailyBalance: number | null;
  interestYtd: number;
  interestLifetime: number;
  firstStatement: string;
  open: boolean;
}

export interface AllySummary {
  asOf: string | null;
  total: number;
  accounts: AllyAccountSummary[];
  series: { date: string; total: number; balances: Record<string, number> }[];
  apy: { date: string; last4: string; apy: number }[];
  interestYears: { year: number; total: number; byAccount: Record<string, number>; statements: number }[];
  interestLifetime: number;
  flows: { month: string; statementDate: string; moneyIn: number; moneyOut: number; interest: number; net: number }[];
  recurring: { payee: string; account: string | null; lastAmount: number; lastDate: string; typicalDay: number; months: number }[];
  gaps: string[];
  nextExpected: string | null;
  firstStatement: string | null;
  events: { date: string; account: string | null; kind: string; description: string; amount: number }[];
}

export interface AllyDashboard {
  kind: 'ally';
  folder: StatementFolder;
  template: { nickname: string; institution: string; type: string; site?: string; phone?: string } | null;
  summary: AllySummary;
  statements: {
    id: string;
    periodEnd: string;
    fileId: string;
    checks: StatementCheckRow[];
    accounts: { last4: string; beginning: number; ending: number; deposits: number; withdrawals: number; interest: number; apy: number | null }[];
  }[];
  /** Last 24 months only (transactionsSince = exclusive start). */
  transactions: { date: string; account: string | null; description: string; kind: string; amount: number }[];
  transactionsSince: string | null;
  files: { fileId: string; name: string; url: string | null; status: string; error: string | null }[];
  flags: { id: string; severity: 'warn' | 'info'; message: string; created_at: string }[];
  cashPlacement?: { bank: CashBankPlacement | null; suggestions: CashSuggestion[]; rules: CashPlacement['rules'] };
}

export interface AmazonStatementRow {
  closingDate: string;
  openingDate: string;
  previousBalance: number;
  paid: number;
  credits: number;
  purchases: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  carried: number;
  pointsEarned: number | null;
  pointsTotal: number | null;
  fileId: string;
  checksOk: boolean;
}

export interface AmazonSummary {
  asOf: string | null;
  latest: AmazonStatementRow | null;
  status: CardStatus;
  balance: number;
  creditLine: number | null;
  availableCredit: number | null;
  utilization: number | null;
  purchaseApr: number | null;
  pointsBalance: number | null;
  pointsValue: number | null;
  pointsAsOf: string | null;
  lifetimePointsEarned: number;
  lifetimePointsRedeemed: number;
  rewardCredits: number;
  shopWithPoints: number;
  rewardRate: number | null;
  ytdPurchases: number;
  ytdNet: number;
  ytdPointsEarned: number;
  last12Net: number;
  last12Amazon: number;
  avgMonthlyNet: number | null;
  lifetimeNet: number;
  firstStatement: string | null;
  paidInFullStreak: number;
  carriedStatements: string[];
  totalInterest: number;
  totalFees: number;
  totalStatementCredits: number;
  charges: { date: string; description: string; kind: 'fee' | 'interest' | 'credit'; amount: number }[];
  changes: { date: string; what: 'apr' | 'credit_line' | 'cash_line' | 'rewards'; from: string; to: string }[];
  statements: AmazonStatementRow[];
  years: { year: number; statements: number; purchases: number; refunds: number; net: number; amazon: number; pointsEarned: number; interest: number; fees: number }[];
  months: { closingDate: string; purchases: number; net: number; balance: number }[];
  points: { closingDate: string; total: number; earned: number; redeemed: number }[];
  categories: { category: string; points: number; last12: number }[];
  topMerchants: { merchant: string; amount: number; count: number }[];
  nextStatementExpected: string | null;
  nextDue: { date: string; amount: number; minimum: number } | null;
}

export interface AmazonDashboard {
  kind: 'amazon';
  folder: StatementFolder;
  template: { nickname: string; institution: string; type: string; site?: string; phone?: string } | null;
  account: { accountLast: string } | null;
  summary: AmazonSummary;
  statements: { id: string; periodStart: string; periodEnd: string; fileId: string; checks: StatementCheckRow[] }[];
  /** Last 24 statements only (transactionsSince = exclusive start). */
  transactions: { date: string; description: string; kind: string; amount: number }[];
  transactionsSince: string | null;
  files: { fileId: string; name: string; url: string | null; status: string; error: string | null }[];
  flags: { id: string; severity: 'warn' | 'info'; message: string; created_at: string }[];
  payTask: { id: string; title: string; due: string | null; status: string | null } | null;
}

export interface AmexBankSummary {
  asOf: string | null;
  last4: string | null;
  label: string;
  product: string | null;
  holders: string | null;
  balance: number;
  apy: number | null;
  rate: number | null;
  interestYtd: number;
  interestLifetime: number;
  firstStatement: string | null;
  series: { date: string; balance: number }[];
  apyPoints: { date: string; apy: number; earned: number | null }[];
  rateChanges: { date: string; from: number; to: number }[];
  interestYears: { year: number; total: number; statements: number; december: boolean }[];
  flows: { month: string; statementDate: string; moneyIn: number; moneyOut: number; interest: number; net: number }[];
  counterparties: { name: string; moneyIn: number; moneyOut: number; count: number; lastDate: string }[];
  gaps: string[];
  nextExpected: string | null;
  events: { date: string; kind: string; description: string; amount: number }[];
}

export interface AmexBankDashboard {
  kind: 'amexBank';
  folder: StatementFolder;
  template: { nickname: string; institution: string; type: string; site?: string; phone?: string } | null;
  summary: AmexBankSummary;
  statements: {
    id: string;
    periodStart: string;
    periodEnd: string;
    fileId: string;
    checks: StatementCheckRow[];
    beginning: number;
    credits: number;
    debits: number;
    interest: number;
    ending: number;
    apy: number | null;
  }[];
  /** Last 24 statements only (transactionsSince = exclusive start). */
  transactions: { date: string; description: string; kind: string; amount: number }[];
  transactionsSince: string | null;
  files: { fileId: string; name: string; url: string | null; status: string; error: string | null }[];
  flags: { id: string; severity: 'warn' | 'info'; message: string; created_at: string }[];
  cashPlacement?: { bank: CashBankPlacement | null; suggestions: CashSuggestion[]; rules: CashPlacement['rules'] };
}

export type FinanceDashboard = Ny529Dashboard | AdtDashboard | AllyDashboard | AmazonDashboard | AmexBankDashboard;

// ---- Account payers (0092_account_payers.sql) — which card pays which
// account. 'autopay' = charges the card by itself; 'on_file' = the card is
// saved there and Mike clicks Pay. ----
export type AccountPayerMode = 'autopay' | 'on_file';

export interface AccountPayer {
  entryId: string;
  mode: AccountPayerMode;
  paymentCardId: string | null;
  payerText: string | null;
  dueDay: number | null;
  label: string | null;
}

/** One account a payment card pays (Wallet "Pays For"). */
export interface CardPaidAccount {
  entryId: string;
  title: string;
  mode: AccountPayerMode;
  folderId: string | null;
  latestBill: string | null;
  due: string | null;
}

// ---- Waiting For (worker/src/waitingRouter.ts, migration 0095) ----
export interface WaitingItem {
  id: string; // the check-back task
  title: string;
  status: string | null;
  dueDate: string | null;
  since: string | null;
  updatedAt: string;
  sourceId: string | null;
  sourceTitle: string | null;
  sourceParentId: string | null;
  sourceParentTitle: string | null;
  sourceParentType: string | null;
}
export interface WaitingList {
  open: WaitingItem[];
  received: WaitingItem[];
}

// ---- Accounts Need Attention (worker/src/statements/attention.ts) ----
export interface FinanceAttentionItem {
  id: string; // statement_flags.id
  folderId: string;
  account: string;
  owner: string;
  severity: string;
  message: string;
  createdAt: string;
}
export interface FinanceAttention {
  count: number;
  items: FinanceAttentionItem[];
}

// ---- Cash Placement (worker/src/statements/cashPlacement.ts) ----
export interface CashIdleCalc {
  asOf: string;
  checking: { last4: string; label: string; apy: number | null };
  savings: { last4: string; label: string; apy: number | null; balance: number } | null;
  months: number;
  medianOutflow: number;
  largestOutflow: number;
  largestMonth: string | null;
  buffer: number;
  avgBalance: number;
  idle: number;
  gainPerYear: number;
}
export type CashIdleStatus = 'suggest' | 'not_held' | 'below_threshold' | 'no_idle' | 'no_savings' | 'insufficient_history' | 'stale';
export interface CashBankPlacement {
  folderId: string;
  bank: string;
  owner: AccountOwner;
  status: CashIdleStatus;
  current: CashIdleCalc | null;
  previous: CashIdleCalc | null;
}
export interface CashSuggestion {
  id: string;
  kind: 'idle' | 'move';
  owner: AccountOwner;
  folderId: string;
  toFolderId: string;
  bank: string;
  toBank: string;
  fromLabel: string;
  toLabel: string;
  fromApy: number;
  toApy: number;
  amount: number;
  gainPerYear: number;
  asOf: string;
  heldSince: string;
  buffer?: number;
  fdicCapped?: boolean;
  message: string;
}
export interface CashPlacement {
  today: string;
  rules: { bufferMonths: number; cushionPct: number; minIdleGain: number; minMoveGain: number; fdicLimit: number };
  banks: CashBankPlacement[];
  suggestions: CashSuggestion[];
}
