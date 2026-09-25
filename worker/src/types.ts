export type EntityType = 'project' | 'folder' | 'note' | 'task' | 'file' | 'link' | 'vault_entry';
export type TaskStatus = 'open' | 'done';
export type ProjectStatus = 'active' | 'archived';

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  content: string | null;
  parent_id: string | null;
  is_top_level: number; // 0 | 1 (D1/SQLite boolean)
  status: string | null;
  position: number;
  pinned: number; // 0 | 1
  is_jot: number; // 0 | 1 — a Jot is stored as type='note' with this flag set, not a distinct type (see migrations/0005_jots.sql)
  is_list: number; // 0 | 1 — a List is stored as type='project' with this flag set, not a distinct type (see migrations/0029_lists.sql)
  due_date: string | null; // 'YYYY-MM-DD' — tasks only (see migrations/0006_planner.sql)
  due_time: string | null; // 'HH:MM' 24h, tasks only, meaningless without due_date (see migrations/0009_due_time.sql)
  due_position: number | null; // manual order among same-due_date tasks — Day view promote/demote (see migrations/0010_due_position.sql)
  last_touched: string | null;
  created_at: string;
  updated_at: string;
  search_text?: string | null; // plain-text mirror of `content`, queried by GET /api/search
  expires_at: string | null; // 'YYYY-MM-DD' — a note/file's expiration date (insurance card, registration...); see migrations/0039_entity_expiration.sql
  expiry_task_id: string | null; // the auto-created reminder task (due 30 days before expires_at), kept in sync by syncExpiryTask — null when expires_at is null
  is_password: number; // 0 | 1 — a Vault Password card is stored as type='note' with this flag set, not a distinct type (see migrations/0041_vault_passwords.sql, same trick as is_jot/is_list)

  subtasks?: Entity[]; // attached in-memory for task children only, not a DB column
  media?: Entity[]; // attached in-memory for task children only (file/link attachments), not a DB column
  is_recurring?: boolean; // attached in-memory — true when this task is the live instance of an active recurring_task_definitions row (its current_task_id), not a DB column on entities itself. See markRecurring in index.ts.
}

export interface Link {
  id: string;
  from_id: string;
  to_id: string;
  link_type: string | null;
  created_at: string;
}

export interface FileMeta {
  r2_key: string;
  mime_type: string;
  size: number;
  filename: string;
}

export interface LinkMeta {
  url: string;
  preview_title?: string | null;
  preview_image?: string | null;
  preview_domain?: string | null;
}

// 'connector' is a freestanding line/arrow object (added migrations/0014 —
// see CanvasItemView / the connector-content comment in CanvasBoardPage.tsx
// on the frontend for the shape of its `content`), not a relationship
// between two other items stored elsewhere — it's just another item.
export type CanvasItemType = 'image' | 'text' | 'note' | 'connector';

export interface CanvasBoard {
  id: string;
  title: string;
  pinned: number; // 0 | 1 — pin-to-top on the boards list, same as Entity.pinned for Projects
  created_at: string;
  updated_at: string;
}

// `content` is stored as a JSON TEXT column (see migrations/0012_canvas_boards.sql
// for the per-type shape) — kept as a raw string here, same as Entity.content,
// and parsed/typed only where a handler actually needs to look inside it.
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

// No stored anchor/side — the line's actual endpoints are derived at
// render time from each item's current box (nearest-edge-midpoint), which
// is what makes the arrow "move with" its cards automatically.
export interface CanvasConnector {
  id: string;
  board_id: string;
  from_item_id: string;
  to_item_id: string;
  created_at: string;
}

// A parked item on the Jots page's "Shelf" — see migrations/0016_shelf_items.sql
// for the per-type `content` shapes. Deliberately flat/global (no board_id
// or parent_id): the Shelf is one drop zone for the whole app, not scoped
// to a project or board.
export type ShelfItemType = 'text' | 'image' | 'link' | 'file';

export interface ShelfItem {
  id: string;
  type: ShelfItemType;
  content: string;
  pinned: number; // 0 | 1 — pin-to-top, same as Entity.pinned
  created_at: string;
}

// See migrations/0017_contacts.sql for the reasoning behind this shape —
// multi-value fields and split month/day/year dates, kept off the Entity
// schema entirely.
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
  headline: string | null; // quick one-line context, separate from address/notes — see 0031_contact_headline_city_connections.sql
  city: string | null; // free-text, for the client-side "what time is it for them" lookup (src/utils/timezones.ts) — no geocoding

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

export interface VoterRecord {
  id: string;
  contact_id: string;
  party: string | null;
  voter_age: number | null;
  household_members: string | null; // JSON string[] — unused for now, see 0022_voter_record_fields.sql
  voting_history: string | null; // JSON — array of { code: string; value: string }
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
  raw_data: string; // JSON
  import_batch_id: string;
  created_at: string;
  updated_at: string;
}

export type ContactNoteSourceType = 'quick_note' | 'jot' | 'note' | 'task';

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

// A meeting-notes linkage (meeting_id -> note_entity_id, see
// migrations/0023_meeting_notes.sql + 0024_meeting_notes_entity_link.sql)
// is read/written directly via raw D1 rows in index.ts — the note itself is
// a regular Entity, so there's no separate response type for it here.

export interface JournalEntry {
  date: string; // 'YYYY-MM-DD'
  content: string | null; // Tiptap JSON
  search_text: string | null;
  mood: number | null; // 1 (rough) – 5 (great); NULL = not logged
  created_at: string;
  updated_at: string;
}

export interface TaskReschedule {
  id: string;
  entity_id: string;
  title: string;
  from_due_date: string;
  to_due_date: string;
  rescheduled_at: string;
  rescheduled_date: string; // 'YYYY-MM-DD'
}

export type HabitDirection = 'build' | 'reduce';

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
}

export interface HabitLog {
  habit_id: string;
  date: string; // 'YYYY-MM-DD'
  value: number;
  created_at: string;
  updated_at: string;
}

export interface HabitEvent {
  id: string;
  habit_id: string;
  occurred_at: string; // ISO instant
  date: string; // 'YYYY-MM-DD', local
  value: number;
  created_at: string;
}

export interface HealthLog {
  date: string; // 'YYYY-MM-DD'
  raw_data: string; // JSON
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

// One row per Google Health weekly-report import — see
// worker/migrations/0025_health_weekly_reports.sql for the full field-by-
// field rationale (self-computed deltas, per-metric null handling).
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

// One row per monthly credit-score check-in — see
// worker/migrations/0042_credit_score.sql for the full rationale
// (CreditSesame/Discover-Fico are historical-only, kept nullable so old
// rows keep their real values; average is computed from whichever columns
// are non-null rather than stored).
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

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  // Comma-separated exact origins (e.g. "https://mikeos.pages.dev,http://localhost:5173").
  // Replaces the old wildcard ALLOWED_ORIGIN: cookie-based auth requires
  // CORS to echo back one specific origin with credentials enabled, which
  // isn't possible with "*" — see worker/src/auth.ts's resolveOrigin().
  ALLOWED_ORIGINS: string;
  // AES-256-GCM key (base64, decodes to exactly 32 bytes — `openssl rand
  // -base64 32`) for Payment Cards' number/CVV fields. A Worker secret,
  // never committed, set via `wrangler secret put PAYMENT_CARD_ENC_KEY` (or
  // the deploy workflow's own step, when the GitHub secret of the same
  // name is set) — see worker/src/cryptoField.ts. Optional at the type
  // level because a fresh environment that hasn't set it yet should still
  // deploy; paymentCards.ts fails those specific requests with a clear
  // error rather than the whole Worker failing to boot.
  PAYMENT_CARD_ENC_KEY?: string;
  // Plex library mirror (see worker/src/plexSync.ts) — a base URL Mike's
  // Plex Media Server is reachable at (its own Remote Access address, or a
  // Cloudflare Tunnel hostname pointed at it — either way, just a URL the
  // Worker can fetch) and the X-Plex-Token that authenticates against it.
  // Both Worker secrets, optional at the type level for the same reason
  // PAYMENT_CARD_ENC_KEY is: a fresh environment should still deploy, and
  // plexSync.ts fails those specific requests with a clear error instead.
  PLEX_SERVER_URL?: string;
  PLEX_TOKEN?: string;
}

// ---- News (RSS reader) — raw D1 row shapes; see
// worker/migrations/0026_news.sql for the schema rationale and
// worker/src/news.ts for the feed parser. Mirrored (API-shaped, with
// computed fields like unread_count) in src/api/types.ts.

export interface NewsFeedRow {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  site_url: string | null;
  favicon_url: string | null;
  position: number;
  last_fetch_error: string | null;
  last_fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewsArticleRow {
  id: string;
  feed_id: string;
  guid: string;
  url: string;
  title: string;
  description: string | null;
  image_url: string | null;
  published_at: string | null;
  fetched_at: string;
}

export interface NewsSavedRow {
  id: string;
  article_id: string | null;
  feed_title: string | null;
  title: string;
  url: string;
  image_url: string | null;
  description: string | null;
  saved_at: string;
}

// Single-row settings table (id fixed to 'default') rather than a generic
// app_settings table since News is the only feature that needs one so far.
// auto_read_hours: null disables auto-read entirely.
export interface NewsSettingsRow {
  id: string;
  auto_read_hours: number | null;
  updated_at: string;
}

// ---- Sports betting dashboard (0032_bets.sql) ----

export type BetResult = 'win' | 'loss' | 'push' | 'void';

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
  created_at: string;
  updated_at: string;
}

// bet_legs (0038_bet_legs.sql) — only populated for Parlay/Same Game
// Parlay/SGP+ bets. See that migration's header for the money-vs-pick-
// accuracy split this exists for.
export interface BetLegRow {
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

// ---- Bets banking/promos/workspace (0040_bet_workspace.sql) ----

export type BetTransactionType = 'deposit' | 'withdrawal' | 'bonus' | 'adjustment';

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
  description: string;
  promo_type: string;
  expires_at: string | null;
  legs: string | null;
  odds: string | null;
  amount: string | null;
  max_bonus: number | null;
  status: BetPromoStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BetGameNoteRow {
  id: string;
  date: string;
  sport: string;
  external_id: string | null;
  matchup: string;
  start_time: string | null;
  note: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface BetGameLineRow {
  id: string;
  game_note_id: string;
  sportsbook: string;
  line: string;
  position: number;
  created_at: string;
  updated_at: string;
}

// ---- App-wide authentication (0033_auth.sql) ----

export type AuthCredentialType = 'webauthn' | 'pin';

export interface AuthCredentialRow {
  id: string;
  type: AuthCredentialType;
  device_label: string;
  webauthn_credential_id: string | null;
  webauthn_public_key: string | null;
  webauthn_counter: number | null;
  webauthn_transports: string | null;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_fail_count: number;
  pin_locked_until: string | null;
  created_at: string;
  last_used_at: string | null;
}

// Safe-to-return-to-the-frontend shape — never includes pin_hash/pin_salt
// or the raw webauthn public key/credential id.
export interface AuthCredentialSummary {
  id: string;
  type: AuthCredentialType;
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}

// ---- Vault (0034_vault.sql) ----

export type VaultFieldType = 'text' | 'number' | 'date' | 'currency' | 'url' | 'contact' | 'duration' | 'list';

export interface VaultFieldDefRow {
  id: string;
  name: string;
  field_type: VaultFieldType;
  created_at: string;
}

export interface VaultFieldGroupRow {
  id: string;
  name: string;
  created_at: string;
}

export interface VaultGroupFieldRow {
  id: string;
  group_id: string;
  field_def_id: string;
  position: number;
}

export interface VaultTemplateRow {
  id: string;
  name: string;
  starter_content: string | null;
  created_at: string;
}

export interface VaultTemplateGroupRow {
  id: string;
  template_id: string;
  group_id: string;
  position: number;
}

export interface VaultEntryGroupRow {
  id: string;
  entry_id: string;
  group_id: string;
  label: string | null;
  position: number;
  created_at: string;
}

export interface VaultFieldValueRow {
  id: string;
  entry_group_id: string;
  field_def_id: string;
  value: string | null;
  position: number;
}

export interface VaultCategoryRow {
  id: string;
  name: string;
  icon: string;
  trigger_field_def_id: string;
  created_at: string;
}

// ---- Vault v2 (0036_vault_facts.sql) — see that migration for why this
// replaces the field-def/group/template registry above (left in place,
// unused, rather than dropped).

export interface VaultFactRow {
  id: string;
  entry_id: string;
  label: string;
  value: string | null;
  position: number;
  created_at: string;
}

// ---- Vault Passwords (0041_vault_passwords.sql) — the credential fields
// for a type='note', is_password=1 entity. 1:1 with that entity's id.

export interface VaultCredentialRow {
  entity_id: string;
  url: string | null;
  username: string | null;
  password: string | null;
  created_at: string;
  updated_at: string;
}
