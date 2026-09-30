import type { Env } from './types';

/** Replaces the "check TrackSeries.tv every day" habit: for every show in
 * the synced Plex library (see plexSync.ts) that Plex has actually
 * matched to a TheTVDB id, look up its TVMaze schedule and flag any
 * episode TVMaze says aired that isn't in the library yet. TVMaze (not
 * TheTVDB directly) because it's free, keyless, and has a lookup-by-
 * thetvdb-id endpoint that maps straight onto what Plex already stores —
 * no separate account/API key for Mike to go set up. Surfaced in the
 * Daily Briefing the same way overdue tasks are: a small table this job
 * maintains, not computed live on every briefing request (unlike the
 * birthday/card-expiry nudges, this genuinely needs an external API call
 * per show, which has no business happening on a page load). */

const TVMAZE_BASE = 'https://api.tvmaze.com';
// How many trailing days to check each run — more than 1 so a single
// missed cron run (Worker hiccup, TVMaze down for a night) doesn't
// silently drop that day's episode from ever surfacing.
const LOOKBACK_DAYS = 3;

async function tvmazeGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${TVMAZE_BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TVMaze ${res.status} on ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Which synced shows still need a fresh TVMaze lookup — Plex has matched
 * them to a TheTVDB id, but they're either never resolved or resolved
 * against a since-changed tvdb_id (a re-match in Plex, most often). Pure
 * read, used to seed runAiringCheckChunk's resolve queue. */
async function pendingTvmazeResolves(env: Env): Promise<{ show_item_id: string; tvdb_id: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.id as show_item_id, s.tvdb_id
     FROM plex_items s
     LEFT JOIN plex_tvmaze_shows t ON t.show_item_id = s.id
     WHERE s.type = 'show' AND s.tvdb_id IS NOT NULL AND (t.show_item_id IS NULL OR t.tvdb_id != s.tvdb_id)`
  ).all<{ show_item_id: string; tvdb_id: string }>();
  return results ?? [];
}

/** Resolves one show's TVMaze id and caches it — the per-item unit of
 * work `runAiringCheckChunk`'s resolve phase spends its budget on. */
async function resolveOneTvmazeShow(env: Env, showItemId: string, tvdbId: string): Promise<void> {
  let tvmazeId: number | null = null;
  try {
    const show = await tvmazeGet<{ id: number }>(`/lookup/shows?thetvdb=${tvdbId}`);
    tvmazeId = show?.id ?? null;
  } catch {
    // A transient TVMaze failure just leaves this show unresolved for
    // now — it's retried next run since nothing gets cached on error.
    return;
  }
  await env.DB.prepare(
    `INSERT INTO plex_tvmaze_shows (show_item_id, tvdb_id, tvmaze_id, resolved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(show_item_id) DO UPDATE SET tvdb_id=excluded.tvdb_id, tvmaze_id=excluded.tvmaze_id, resolved_at=excluded.resolved_at`
  )
    .bind(showItemId, tvdbId, tvmazeId, new Date().toISOString())
    .run();
}

/** Marks a "Download <Show> SxxExx" task done (if it's still open) —
 * shared by reconciliation (the episode showed up) and dismissal (Mike
 * said he doesn't want it), which land on different outcomes below. */
export async function completeEpisodeTask(env: Env, taskId: string): Promise<void> {
  await env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ? AND type = 'task' AND status = 'open'`)
    .bind(new Date().toISOString(), taskId)
    .run();
}

/** Deletes a "Download <Show> SxxExx" task outright — used on dismissal,
 * where Mike is saying he doesn't want this episode at all, so "done"
 * (which reads as "I got it") would be the wrong signal. */
export async function deleteEpisodeTask(env: Env, taskId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM entities WHERE id = ? AND type = 'task'`).bind(taskId).run();
}

/** Drops any open (non-dismissed) missing-episode row whose episode has
 * since actually shown up in the synced library — run on every check so
 * a download Mike already did stops nagging, regardless of how old the
 * flag was. Also completes that episode's download task, if it had one,
 * rather than leaving it open now that the episode is actually in hand. */
async function reconcileMissingEpisodes(env: Env): Promise<void> {
  const { results: resolved } = await env.DB.prepare(
    `SELECT id, task_id FROM plex_missing_episodes
     WHERE dismissed = 0
     AND task_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM plex_items e
       JOIN plex_items se ON e.parent_id = se.id
       WHERE se.parent_id = plex_missing_episodes.show_item_id
         AND e.type = 'episode'
         AND e.season_number = plex_missing_episodes.season_number
         AND e.episode_number = plex_missing_episodes.episode_number
     )`
  ).all<{ id: string; task_id: string }>();
  for (const row of resolved ?? []) {
    await completeEpisodeTask(env, row.task_id);
  }

  await env.DB.prepare(
    `DELETE FROM plex_missing_episodes
     WHERE dismissed = 0
     AND EXISTS (
       SELECT 1 FROM plex_items e
       JOIN plex_items se ON e.parent_id = se.id
       WHERE se.parent_id = plex_missing_episodes.show_item_id
         AND e.type = 'episode'
         AND e.season_number = plex_missing_episodes.season_number
         AND e.episode_number = plex_missing_episodes.episode_number
     )`
  ).run();
}

interface TvmazeEpisode {
  season: number;
  number: number;
  name: string;
  airdate: string;
}

async function hasEpisode(env: Env, showItemId: string, season: number, episode: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT e.id FROM plex_items e
     JOIN plex_items se ON e.parent_id = se.id
     WHERE se.parent_id = ? AND e.type = 'episode' AND e.season_number = ? AND e.episode_number = ?
     LIMIT 1`
  )
    .bind(showItemId, season, episode)
    .first();
  return !!row;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Creates the "Download <Show> SxxExx" task for a newly-flagged episode
 * and links it back onto that missing-episode row (via task_id) so
 * reconciliation/dismissal can find and close it later. A standalone
 * top-level task — same "addressable at the root, no project" shape the
 * recurring-task spawner uses for a definition with no project_id —
 * since a missing episode isn't naturally under any existing MikeOS
 * project. Due today, the day the check actually ran and found it, which
 * in practice is always the morning after the episode aired (see
 * recentLookbackDates/LOOKBACK_DAYS): that's what puts it in front of
 * Mike on his next Today view rather than backdating it to the air date
 * itself and landing it in Overdue immediately. */
async function createEpisodeTask(env: Env, missingEpisodeId: string, showTitle: string, season: number, episode: number): Promise<void> {
  const taskId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const today = dateStr(new Date());
  const maxPos = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{
    m: number;
  }>();
  await env.DB.prepare(
    `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at)
     VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?)`
  )
    .bind(taskId, `Download ${showTitle} S${pad2(season)}E${pad2(episode)}`, (maxPos?.m ?? -1) + 1, today, ts, ts, ts)
    .run();
  await env.DB.prepare(`UPDATE plex_missing_episodes SET task_id = ? WHERE id = ?`).bind(taskId, missingEpisodeId).run();
}

function recentLookbackDates(): string[] {
  const today = new Date();
  const dates: string[] = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(dateStr(d));
  }
  return dates;
}

/** Checks one show's last few days for aired episodes and flags any that
 * aren't in the synced library yet — the per-item unit of work
 * `runAiringCheckChunk`'s check phase spends its budget on. Returns how
 * many new rows it flagged. */
async function checkOneShowRecentAirings(env: Env, showItemId: string, showTitle: string, tvmazeId: number, dates: string[]): Promise<number> {
  let flagged = 0;
  for (const date of dates) {
    let episodes: TvmazeEpisode[] | null = null;
    try {
      episodes = await tvmazeGet<TvmazeEpisode[]>(`/shows/${tvmazeId}/episodesbydate?date=${date}`);
    } catch {
      continue; // transient failure — this date/show just gets picked up again next run
    }
    for (const ep of episodes ?? []) {
      if (await hasEpisode(env, showItemId, ep.season, ep.number)) continue;
      // ON CONFLICT DO NOTHING — if Mike already dismissed this one,
      // re-detecting it on a later run must not resurrect it (and must
      // not spawn a second download task for it either).
      const missingEpisodeId = crypto.randomUUID();
      const inserted = await env.DB.prepare(
        `INSERT INTO plex_missing_episodes (id, show_item_id, show_title, season_number, episode_number, episode_name, aired_on, detected_at, dismissed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(show_item_id, season_number, episode_number) DO NOTHING`
      )
        .bind(missingEpisodeId, showItemId, showTitle, ep.season, ep.number, ep.name || null, ep.airdate, new Date().toISOString())
        .run();
      if (inserted.meta.changes > 0) {
        flagged++;
        await createEpisodeTask(env, missingEpisodeId, showTitle, ep.season, ep.number);
      }
    }
  }
  return flagged;
}

export interface AiringCheckResult {
  showsResolved: number;
  newlyFlagged: number;
}

// ---- Chunked/resumable nightly Airing check ----
//
// This used to run everything — resolving every show's TVMaze id, then
// checking every resolved show's last few days — in one unbounded pass
// within a single Worker invocation, on the theory that "just the last 3
// days" was cheap regardless of library size. Wrong at Mike's library
// scale (669 shows): the first cold resolve pass alone is 669 sequential
// TVMaze lookups + D1 writes, which hit a D1 connection timeout partway
// through ("D1_ERROR: Network connection lost") — exactly the kind of
// silent nightly failure (the cron's own try/catch just logs and moves
// on) that let Ted Lasso S04E09 / It's Always Sunny S18E08 go unflagged
// despite the library otherwise being fine. Same chunked/resumable shape
// as the Plex library sync and the full-history scan now: state persists
// in plex_airing_check_state (migrations/0069) between chunks, and the
// caller (the "Check now" button, or the nightly cron's self-fetch loop —
// see index.ts) keeps calling until `done`.

const CHECK_SUBREQUEST_BUDGET_PER_CHUNK = 100;

interface AiringCheckState {
  phase: 'resolve' | 'reconciled' | 'check';
  resolveQueue: { showItemId: string; tvdbId: string }[];
  checkQueue: { showItemId: string; showTitle: string; tvmazeId: number }[];
  dates: string[];
  showsResolved: number;
  newlyFlagged: number;
}

async function loadCheckState(env: Env): Promise<AiringCheckState | null> {
  const row = await env.DB.prepare(`SELECT state_json FROM plex_airing_check_state WHERE id = 1`).first<{ state_json: string }>();
  return row ? (JSON.parse(row.state_json) as AiringCheckState) : null;
}

async function saveCheckState(env: Env, state: AiringCheckState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plex_airing_check_state (id, state_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(state), new Date().toISOString())
    .run();
}

async function clearCheckState(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM plex_airing_check_state WHERE id = 1`).run();
}

export interface AiringCheckChunkResult {
  done: boolean;
  progress: { phase: string; showsResolved: number; newlyFlagged: number };
  summary?: AiringCheckResult;
}

/** Does one bounded slice of the nightly Airing check and returns whether
 * it's done — see the header comment above for why this is chunked at
 * all. Safe to call repeatedly, including as the very first call (which
 * initializes fresh state), until `done` comes back true. */
export async function runAiringCheckChunk(env: Env): Promise<AiringCheckChunkResult> {
  const loaded = await loadCheckState(env);
  let spent = 0;

  const state: AiringCheckState =
    loaded ?? { phase: 'resolve', resolveQueue: [], checkQueue: [], dates: recentLookbackDates(), showsResolved: 0, newlyFlagged: 0 };
  if (!loaded) {
    state.resolveQueue = (await pendingTvmazeResolves(env)).map((r) => ({ showItemId: r.show_item_id, tvdbId: r.tvdb_id }));
  }

  while (spent < CHECK_SUBREQUEST_BUDGET_PER_CHUNK) {
    if (state.phase === 'resolve') {
      const next = state.resolveQueue.shift();
      if (!next) {
        state.phase = 'reconciled';
        continue;
      }
      await resolveOneTvmazeShow(env, next.showItemId, next.tvdbId);
      state.showsResolved++;
      spent += 2; // one TVMaze lookup + one D1 upsert
      continue;
    }

    if (state.phase === 'reconciled') {
      // Drops any open missing-episode row whose episode has since shown
      // up in the library — cheap, one query, run once per check rather
      // than per show.
      await reconcileMissingEpisodes(env);
      spent++;
      const { results: shows } = await env.DB.prepare(
        `SELECT s.id as show_item_id, s.title as show_title, t.tvmaze_id
         FROM plex_items s
         JOIN plex_tvmaze_shows t ON t.show_item_id = s.id
         WHERE s.type = 'show' AND t.tvmaze_id IS NOT NULL`
      ).all<{ show_item_id: string; show_title: string; tvmaze_id: number }>();
      state.checkQueue = (shows ?? []).map((s) => ({ showItemId: s.show_item_id, showTitle: s.show_title, tvmazeId: s.tvmaze_id }));
      spent++;
      state.phase = 'check';
      continue;
    }

    // phase === 'check'
    const next = state.checkQueue.shift();
    if (!next) {
      const summary = { showsResolved: state.showsResolved, newlyFlagged: state.newlyFlagged };
      await clearCheckState(env);
      return { done: true, progress: { phase: 'check', ...summary }, summary };
    }
    const flagged = await checkOneShowRecentAirings(env, next.showItemId, next.showTitle, next.tvmazeId, state.dates);
    state.newlyFlagged += flagged;
    spent += 1 + state.dates.length; // rough: one D1 read for the show plus one TVMaze call per lookback date
  }

  await saveCheckState(env, state);
  return { done: false, progress: { phase: state.phase, showsResolved: state.showsResolved, newlyFlagged: state.newlyFlagged } };
}

// ---- Full-history scan — manually triggered, not nightly ----
//
// The nightly check above only ever asks "what aired in the last few
// days", which is intentionally cheap but blind to older gaps — a show
// added to the library after being missing a season from three years ago
// would never get flagged by it. This walks each show's *entire* TVMaze
// episode list instead of a recent-day window, which is actually fewer
// TVMaze calls per show (one full list vs. one call per lookback day) but
// touches a lot more episodes overall, so — same reasoning as the Plex
// library sync itself — it's chunked and resumable rather than one big
// pass, to stay under Cloudflare's per-invocation subrequest cap on a
// library with a lot of shows/seasons. State persists in
// plex_airing_scan_state (see migrations/0053) as a JSON blob between
// chunks; the caller (the "Scan full history" button) keeps calling until
// `done`.

const SCAN_SUBREQUEST_BUDGET_PER_CHUNK = 150;

interface AiringScanState {
  queue: { showItemId: string; showTitle: string; tvmazeId: number }[];
  showsScanned: number;
  showsTotal: number;
  newlyFlagged: number;
}

async function loadScanState(env: Env): Promise<AiringScanState | null> {
  const row = await env.DB.prepare(`SELECT state_json FROM plex_airing_scan_state WHERE id = 1`).first<{ state_json: string }>();
  return row ? (JSON.parse(row.state_json) as AiringScanState) : null;
}

async function saveScanState(env: Env, state: AiringScanState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plex_airing_scan_state (id, state_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(state), new Date().toISOString())
    .run();
}

async function clearScanState(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM plex_airing_scan_state WHERE id = 1`).run();
}

export interface AiringScanChunkResult {
  done: boolean;
  progress: { showsScanned: number; showsTotal: number; newlyFlagged: number };
  summary?: { showsScanned: number; newlyFlagged: number };
}

export async function runFullHistoryScanChunk(env: Env): Promise<AiringScanChunkResult> {
  let state = await loadScanState(env);

  if (!state) {
    // Fresh run: clear out anything already fixed since the last check —
    // same housekeeping the nightly job does — then queue up every show
    // that already has a resolved TVMaze id. Resolving ids themselves is
    // NOT done inline here (it used to be, unbounded, which could itself
    // time out on a large library before this function ever returned its
    // first chunk) — run "Check now" first (or let the nightly job run)
    // if a show was just added and needs resolving before its history can
    // be scanned.
    await reconcileMissingEpisodes(env);
    const { results: shows } = await env.DB.prepare(
      `SELECT s.id as show_item_id, s.title as show_title, t.tvmaze_id
       FROM plex_items s
       JOIN plex_tvmaze_shows t ON t.show_item_id = s.id
       WHERE s.type = 'show' AND t.tvmaze_id IS NOT NULL`
    ).all<{ show_item_id: string; show_title: string; tvmaze_id: number }>();
    const queue = (shows ?? []).map((s) => ({ showItemId: s.show_item_id, showTitle: s.show_title, tvmazeId: s.tvmaze_id }));
    state = { queue, showsScanned: 0, showsTotal: queue.length, newlyFlagged: 0 };
  }

  const today = dateStr(new Date());
  let spent = 0;

  while (state.queue.length > 0 && spent < SCAN_SUBREQUEST_BUDGET_PER_CHUNK) {
    const show = state.queue.shift()!;
    let episodes: TvmazeEpisode[] | null = null;
    try {
      episodes = await tvmazeGet<TvmazeEpisode[]>(`/shows/${show.tvmazeId}/episodes`);
    } catch {
      // Transient TVMaze failure — this show just gets skipped this scan;
      // it's picked up fresh on the next "Scan full history" run.
      state.showsScanned++;
      spent++;
      continue;
    }
    spent++;
    for (const ep of episodes ?? []) {
      if (!ep.airdate || ep.airdate > today) continue; // unaired/TBA — nothing to flag yet
      if (await hasEpisode(env, show.showItemId, ep.season, ep.number)) {
        spent++;
        continue;
      }
      spent++;
      // Deliberately doesn't spawn a download task the way the nightly
      // check's flags do (see createEpisodeTask) — a first full-history
      // scan on a library this size can surface a large batch of old
      // gaps at once, and dropping dozens of tasks into Today in one shot
      // would swamp it. These still show up in the Airing panel itself;
      // they just don't self-add to the task list.
      const inserted = await env.DB.prepare(
        `INSERT INTO plex_missing_episodes (id, show_item_id, show_title, season_number, episode_number, episode_name, aired_on, detected_at, dismissed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(show_item_id, season_number, episode_number) DO NOTHING`
      )
        .bind(crypto.randomUUID(), show.showItemId, show.showTitle, ep.season, ep.number, ep.name || null, ep.airdate, new Date().toISOString())
        .run();
      spent++;
      if (inserted.meta.changes > 0) state.newlyFlagged++;
    }
    state.showsScanned++;
  }

  if (state.queue.length === 0) {
    const summary = { showsScanned: state.showsScanned, newlyFlagged: state.newlyFlagged };
    await clearScanState(env);
    return { done: true, progress: { ...summary, showsTotal: state.showsTotal }, summary };
  }

  await saveScanState(env, state);
  return { done: false, progress: { showsScanned: state.showsScanned, showsTotal: state.showsTotal, newlyFlagged: state.newlyFlagged } };
}
