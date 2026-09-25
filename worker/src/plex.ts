import { Hono } from 'hono';
import type { Env } from './types';
import { runPlexSyncChunk, PlexNotConfiguredError } from './plexSync';
import { runPlexAiringCheck, runFullHistoryScanChunk } from './plexAiring';

/** Plex library mirror — browse/search the synced catalogue, surface
 * metadata gaps, and manage aired-but-missing episode flags. See
 * migrations/0051_plex.sql for the schema and plexSync.ts/plexAiring.ts
 * for how the data actually gets here. Mounted at /api/plex. */
export const plexRouter = new Hono<{ Bindings: Env }>();

interface LibraryRow {
  id: string;
  title: string;
  library_type: string;
  item_count: number;
  synced_at: string | null;
}

// The count shown is computed live from plex_items rather than trusted
// from plex_libraries.item_count — that column only gets its final write
// once a library's sync chunk loop runs all the way to completion (see
// plexSync.ts's finishCurrentLibrary), so an interrupted sync (subrequest
// cap, a D1 write-quota outage, a closed browser tab mid-poll) can leave
// it stuck at a stale value — 0, typically — even though the items
// themselves synced in fine. A live COUNT can't drift from reality the
// same way; idx_plex_items_library keeps it cheap at this data scale.
plexRouter.get('/libraries', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.title, l.library_type, l.synced_at, COUNT(i.id) as item_count
     FROM plex_libraries l
     LEFT JOIN plex_items i ON i.library_id = l.id
     GROUP BY l.id
     ORDER BY l.title COLLATE NOCASE ASC`
  ).all<LibraryRow>();
  return c.json(
    (results ?? []).map((r) => ({ id: r.id, title: r.title, libraryType: r.library_type, itemCount: r.item_count, syncedAt: r.synced_at }))
  );
});

interface ItemRow {
  id: string;
  library_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  sort_title: string | null;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  guid: string | null;
  tvdb_id: string | null;
  summary: string | null;
  genres: string | null;
  studio: string | null;
  thumb_key: string | null;
  file_path: string | null;
  duration_ms: number | null;
  added_at: string | null;
  plex_updated_at: string | null;
  synced_at: string;
}

function itemJson(r: ItemRow) {
  return {
    id: r.id,
    libraryId: r.library_id,
    parentId: r.parent_id,
    type: r.type,
    title: r.title,
    sortTitle: r.sort_title,
    year: r.year,
    seasonNumber: r.season_number,
    episodeNumber: r.episode_number,
    matched: !!r.guid && !r.guid.startsWith('local://'),
    summary: r.summary,
    genres: r.genres ? r.genres.split(', ') : [],
    studio: r.studio,
    thumbUrl: r.thumb_key ? `/api/plex/thumb/${r.id}` : null,
    filePath: r.file_path,
    durationMs: r.duration_ms,
    addedAt: r.added_at,
    plexUpdatedAt: r.plex_updated_at,
  };
}

// GET /items — browse. With `parentId`, lists that item's direct
// children (a show's seasons, a season's episodes, an artist's albums, an
// album's tracks). With `libraryId` and no `parentId`, lists that
// library's top-level items (movies; shows; artists). With `q`, searches
// titles across everything regardless of level — the flat table makes
// this trivial, no separate search index needed for what's realistically
// a few tens of thousands of rows.
plexRouter.get('/items', async (c) => {
  const libraryId = c.req.query('libraryId');
  const parentId = c.req.query('parentId');
  const q = c.req.query('q')?.trim();

  if (q) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM plex_items WHERE title LIKE ? ${libraryId ? 'AND library_id = ?' : ''} ORDER BY title COLLATE NOCASE ASC LIMIT 200`
    )
      .bind(...(libraryId ? [`%${q}%`, libraryId] : [`%${q}%`]))
      .all<ItemRow>();
    return c.json((results ?? []).map(itemJson));
  }

  if (parentId) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM plex_items WHERE parent_id = ? ORDER BY season_number ASC, episode_number ASC, sort_title COLLATE NOCASE ASC, title COLLATE NOCASE ASC`
    )
      .bind(parentId)
      .all<ItemRow>();
    return c.json((results ?? []).map(itemJson));
  }

  if (!libraryId) return c.json({ error: 'libraryId or parentId or q is required' }, 400);
  // `type` flattens the root listing to one item type instead of the
  // usual top level (e.g. Audiobooks defaults to book titles — "album" in
  // Plex's own model — rather than authors first; see PlexLibraryPanel).
  const flattenType = c.req.query('type');
  const { results } = await c.env.DB.prepare(
    flattenType
      ? `SELECT * FROM plex_items WHERE library_id = ? AND type = ? ORDER BY sort_title COLLATE NOCASE ASC, title COLLATE NOCASE ASC`
      : `SELECT * FROM plex_items WHERE library_id = ? AND parent_id IS NULL ORDER BY sort_title COLLATE NOCASE ASC, title COLLATE NOCASE ASC`
  )
    .bind(...(flattenType ? [libraryId, flattenType] : [libraryId]))
    .all<ItemRow>();
  return c.json((results ?? []).map(itemJson));
});

// GET /items/:id — one item plus its breadcrumb (walking parent_id up to
// the root) so the browse UI can render "Show › Season 2 › Episode 5"
// without a separate round trip per level.
plexRouter.get('/items/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM plex_items WHERE id = ?').bind(c.req.param('id')).first<ItemRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const breadcrumb: { id: string; title: string }[] = [];
  let parentId = row.parent_id;
  while (parentId) {
    const p = await c.env.DB.prepare('SELECT id, title, parent_id FROM plex_items WHERE id = ?').bind(parentId).first<{ id: string; title: string; parent_id: string | null }>();
    if (!p) break;
    breadcrumb.unshift({ id: p.id, title: p.title });
    parentId = p.parent_id;
  }
  return c.json({ ...itemJson(row), breadcrumb });
});

// GET /thumb/:id — proxies Plex's own artwork through the Worker so the
// frontend never needs the Plex token client-side. Long cache since art
// essentially never changes once matched.
plexRouter.get('/thumb/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT thumb_key FROM plex_items WHERE id = ?').bind(c.req.param('id')).first<{ thumb_key: string | null }>();
  if (!row?.thumb_key) return c.notFound();
  if (!c.env.PLEX_SERVER_URL || !c.env.PLEX_TOKEN) return c.json({ error: 'Plex not connected' }, 503);
  const url = new URL(row.thumb_key, c.env.PLEX_SERVER_URL.replace(/\/$/, '') + '/');
  url.searchParams.set('X-Plex-Token', c.env.PLEX_TOKEN);
  const res = await fetch(url.toString());
  if (!res.ok) return c.notFound();
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
});

// POST /sync — one bounded chunk of the library sync, same job the
// nightly Cron Trigger runs (see index.ts's `scheduled` export). Chunked
// because a very large library's full sync can exceed Cloudflare's per-
// invocation subrequest cap in one shot — see plexSync.ts's header
// comment. The caller (the "Sync now" button, or the cron's own self-
// fetch loop) keeps calling this until the response says `done`.
plexRouter.post('/sync', async (c) => {
  try {
    const result = await runPlexSyncChunk(c.env);
    return c.json(result);
  } catch (err) {
    if (err instanceof PlexNotConfiguredError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : 'sync failed' }, 500);
  }
});

plexRouter.post('/airing-check', async (c) => {
  try {
    const result = await runPlexAiringCheck(c.env);
    return c.json(result);
  } catch (err) {
    if (err instanceof PlexNotConfiguredError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : 'airing check failed' }, 500);
  }
});

// POST /airing-scan — one bounded chunk of the manually-triggered full-
// history scan (see plexAiring.ts's header comment above
// runFullHistoryScanChunk for why this one's chunked and the nightly
// check above isn't). The "Scan full history" button keeps calling this
// until the response says `done`, same polling shape as "Sync now".
plexRouter.post('/airing-scan', async (c) => {
  try {
    const result = await runFullHistoryScanChunk(c.env);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'full history scan failed' }, 500);
  }
});

// ---- Metadata gaps ("Needs attention") — plain rules over the synced
// data, computed on request rather than materialized: cheap (one scoped
// query), and always exactly as fresh as the last sync. Requires
// libraryId so a click into "Needs attention" always means one specific
// library's worth of rows, never a full-catalogue scan by accident. ----

interface PlexIssue {
  id: string;
  title: string;
  type: string;
  issues: string[];
}

function detectIssues(rows: ItemRow[], libraryType: string): PlexIssue[] {
  const out: PlexIssue[] = [];
  for (const r of rows) {
    const issues: string[] = [];
    const unmatched = !r.guid || r.guid.startsWith('local://');
    if (r.type === 'movie' || r.type === 'show') {
      if (unmatched) issues.push('Not matched to metadata');
      if (!r.summary) issues.push('Missing summary');
      if (!r.year) issues.push('Missing year');
      if (!r.thumb_key) issues.push('Missing artwork');
      if (!r.genres) issues.push('Missing genres');
    } else if (r.type === 'track') {
      if (!r.episode_number) issues.push('Missing track number');
      if (!r.genres) issues.push('Missing genre');
    } else if (r.type === 'album') {
      if (!r.year) issues.push('Missing year');
      if (!r.thumb_key) issues.push('Missing artwork');
    } else if (r.type === 'episode') {
      if (unmatched) issues.push('Not matched to metadata');
      if (!r.summary) issues.push('Missing summary');
    }
    if (issues.length) out.push({ id: r.id, title: r.title, type: r.type, issues });
  }
  return out;
}

plexRouter.get('/issues', async (c) => {
  const libraryId = c.req.query('libraryId');
  if (!libraryId) return c.json({ error: 'libraryId is required' }, 400);
  const lib = await c.env.DB.prepare('SELECT library_type FROM plex_libraries WHERE id = ?').bind(libraryId).first<{ library_type: string }>();
  if (!lib) return c.json({ error: 'not found' }, 404);
  // "Various Artists" is a music-specific smell that needs a join up to
  // the artist row (a track's own row has no artist name on it), so it's
  // handled as an extra pass rather than folded into detectIssues above.
  const { results } = await c.env.DB.prepare(`SELECT * FROM plex_items WHERE library_id = ? AND type != 'artist' AND type != 'season'`).bind(libraryId).all<ItemRow>();
  const issues = detectIssues(results ?? [], lib.library_type);

  if (lib.library_type === 'artist') {
    const { results: variousTracks } = await c.env.DB.prepare(
      `SELECT tr.id, tr.title, tr.type FROM plex_items tr
       JOIN plex_items al ON tr.parent_id = al.id
       JOIN plex_items ar ON al.parent_id = ar.id
       WHERE tr.library_id = ? AND tr.type = 'track' AND ar.title LIKE '%Various%'`
    )
      .bind(libraryId)
      .all<{ id: string; title: string; type: string }>();
    for (const t of variousTracks ?? []) {
      const existing = issues.find((i) => i.id === t.id);
      if (existing) existing.issues.push('Various Artists — may need per-track artist tags');
      else issues.push({ id: t.id, title: t.title, type: t.type, issues: ['Various Artists — may need per-track artist tags'] });
    }
  }

  return c.json(issues);
});

// ---- Aired-but-missing episodes (see plexAiring.ts) ----

interface MissingEpisodeRow {
  id: string;
  show_item_id: string;
  show_title: string;
  season_number: number;
  episode_number: number;
  episode_name: string | null;
  aired_on: string;
  detected_at: string;
  dismissed: number;
}

function missingEpisodeJson(r: MissingEpisodeRow) {
  return {
    id: r.id,
    showItemId: r.show_item_id,
    showTitle: r.show_title,
    seasonNumber: r.season_number,
    episodeNumber: r.episode_number,
    episodeName: r.episode_name,
    airedOn: r.aired_on,
    detectedAt: r.detected_at,
    dismissed: r.dismissed === 1,
  };
}

plexRouter.get('/missing-episodes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM plex_missing_episodes WHERE dismissed = 0 ORDER BY aired_on DESC').all<MissingEpisodeRow>();
  return c.json((results ?? []).map(missingEpisodeJson));
});

plexRouter.patch('/missing-episodes/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ dismissed?: boolean }>();
  if (body.dismissed !== undefined) {
    await c.env.DB.prepare('UPDATE plex_missing_episodes SET dismissed = ? WHERE id = ?').bind(body.dismissed ? 1 : 0, id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM plex_missing_episodes WHERE id = ?').bind(id).first<MissingEpisodeRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(missingEpisodeJson(row));
});
