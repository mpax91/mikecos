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
