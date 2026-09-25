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

/** Resolves (and caches) a TVMaze show id for every synced show Plex has
 * matched to a TheTVDB id, skipping ones already resolved against the
 * same tvdb_id — only a re-match in Plex (or a first-time sync) causes a
 * fresh lookup. */
async function resolveTvmazeShowIds(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT s.id as show_item_id, s.tvdb_id
     FROM plex_items s
     LEFT JOIN plex_tvmaze_shows t ON t.show_item_id = s.id
     WHERE s.type = 'show' AND s.tvdb_id IS NOT NULL AND (t.show_item_id IS NULL OR t.tvdb_id != s.tvdb_id)`
  ).all<{ show_item_id: string; tvdb_id: string }>();

  for (const row of results ?? []) {
    let tvmazeId: number | null = null;
    try {
      const show = await tvmazeGet<{ id: number }>(`/lookup/shows?thetvdb=${row.tvdb_id}`);
      tvmazeId = show?.id ?? null;
    } catch {
      // A transient TVMaze failure just leaves this show unresolved for
      // now — it's retried next run since nothing gets cached on error.
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO plex_tvmaze_shows (show_item_id, tvdb_id, tvmaze_id, resolved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(show_item_id) DO UPDATE SET tvdb_id=excluded.tvdb_id, tvmaze_id=excluded.tvmaze_id, resolved_at=excluded.resolved_at`
    )
      .bind(row.show_item_id, row.tvdb_id, tvmazeId, new Date().toISOString())
      .run();
  }
}

/** Drops any open (non-dismissed) missing-episode row whose episode has
 * since actually shown up in the synced library — run on every check so
 * a download Mike already did stops nagging, regardless of how old the
 * flag was. */
async function reconcileMissingEpisodes(env: Env): Promise<void> {
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

/** For every show with a resolved TVMaze id, checks the last few days for
 * aired episodes and flags any that aren't in the synced library. Runs
 * shows sequentially (not in parallel) — deliberately gentle on TVMaze's
 * API rather than fast; a nightly job has no reason to hurry. */
async function checkRecentAirings(env: Env): Promise<number> {
  const { results: shows } = await env.DB.prepare(
    `SELECT s.id as show_item_id, s.title as show_title, t.tvmaze_id
     FROM plex_items s
     JOIN plex_tvmaze_shows t ON t.show_item_id = s.id
     WHERE s.type = 'show' AND t.tvmaze_id IS NOT NULL`
  ).all<{ show_item_id: string; show_title: string; tvmaze_id: number }>();

  const today = new Date();
  const dates: string[] = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(dateStr(d));
  }

  let flagged = 0;
  for (const show of shows ?? []) {
    for (const date of dates) {
      let episodes: TvmazeEpisode[] | null = null;
      try {
        episodes = await tvmazeGet<TvmazeEpisode[]>(`/shows/${show.tvmaze_id}/episodesbydate?date=${date}`);
      } catch {
        continue; // transient failure — this date/show just gets picked up again next run
      }
      for (const ep of episodes ?? []) {
        if (await hasEpisode(env, show.show_item_id, ep.season, ep.number)) continue;
        // ON CONFLICT DO NOTHING — if Mike already dismissed this one,
        // re-detecting it on a later run must not resurrect it.
        const inserted = await env.DB.prepare(
          `INSERT INTO plex_missing_episodes (id, show_item_id, show_title, season_number, episode_number, episode_name, aired_on, detected_at, dismissed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(show_item_id, season_number, episode_number) DO NOTHING`
        )
          .bind(crypto.randomUUID(), show.show_item_id, show.show_title, ep.season, ep.number, ep.name || null, ep.airdate, new Date().toISOString())
          .run();
        if (inserted.meta.changes > 0) flagged++;
      }
    }
  }
  return flagged;
}

export interface AiringCheckResult {
  showsResolved: number;
  newlyFlagged: number;
}

export async function runPlexAiringCheck(env: Env): Promise<AiringCheckResult> {
  await resolveTvmazeShowIds(env);
  await reconcileMissingEpisodes(env);
  const newlyFlagged = await checkRecentAirings(env);
  const resolvedCount = await env.DB.prepare(`SELECT COUNT(*) as n FROM plex_tvmaze_shows WHERE tvmaze_id IS NOT NULL`).first<{ n: number }>();
  return { showsResolved: resolvedCount?.n ?? 0, newlyFlagged };
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
    // Fresh run: make sure every show's TVMaze id is as up to date as
    // possible first, and clear out anything already fixed since the last
    // check — same housekeeping the nightly job does — then queue up
    // every show that has a resolved TVMaze id.
    await resolveTvmazeShowIds(env);
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
