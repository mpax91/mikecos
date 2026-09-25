import type { Env } from './types';

/** Talks to Mike's own Plex Media Server (never plex.tv) and mirrors its
 * catalogue into D1 — see migrations/0051_plex.sql for why this is a
 * synced copy rather than live-querying Plex on every page load. Plex's
 * API is JSON when asked nicely (`Accept: application/json`); every
 * response is wrapped in a top-level `MediaContainer`.
 *
 * The sync is CHUNKED and RESUMABLE (migrations/0052_plex_sync_state.sql
 * holds the one row of progress state) rather than one big pass over the
 * whole library in a single call. Cloudflare caps how many subrequests
 * (outbound fetches + D1 calls) a single Worker invocation can make —
 * Mike's library is large enough (many shows, each needing its own
 * `/allLeaves` fetch plus several D1 upsert batches) that doing it all in
 * one invocation hit that cap ("Too many subrequests by single Worker
 * invocation"). Each call to runPlexSyncChunk() does a bounded amount of
 * work and saves its place; the caller (the manual "Sync now" button
 * polling in a loop, or the nightly cron self-fetching its own endpoint —
 * see index.ts) keeps calling until it reports done. Each such call is a
 * genuinely separate Worker invocation, so it gets its own fresh
 * subrequest budget. */

export class PlexNotConfiguredError extends Error {
  constructor() {
    super('Plex isn’t connected yet — set PLEX_SERVER_URL and PLEX_TOKEN (see Settings → Plex for how).');
    this.name = 'PlexNotConfiguredError';
  }
}

function baseUrl(env: Env): { url: string; token: string } {
  if (!env.PLEX_SERVER_URL || !env.PLEX_TOKEN) throw new PlexNotConfiguredError();
  return { url: env.PLEX_SERVER_URL.replace(/\/$/, ''), token: env.PLEX_TOKEN };
}

// Every Plex object type this sync cares about, loosely — Plex's API
// returns a lot more than this, but these are the fields actually used
// below. Left mostly optional/`any`-ish on purpose: better to under-type
// an external API's response shape than to have the sync silently throw
// on a field Plex omits for some particular item.
interface PlexMetadata {
  ratingKey: string;
  key?: string;
  guid?: string;
  Guid?: { id: string }[];
  type: string; // movie | show | season | episode | artist | album | track
  title: string;
  titleSort?: string;
  year?: number;
  index?: number; // episode number (on an episode) / track number (on a track)
  parentIndex?: number; // season number (on an episode)
  parentRatingKey?: string;
  parentTitle?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  summary?: string;
  studio?: string;
  thumb?: string;
  addedAt?: number; // epoch seconds
  updatedAt?: number; // epoch seconds
  duration?: number; // ms
  Genre?: { tag: string }[];
  Media?: { Part?: { file?: string }[] }[];
}

interface PlexContainer<T> {
  MediaContainer: {
    size?: number;
    totalSize?: number;
    Directory?: T[];
    Metadata?: T[];
  };
}

async function plexFetch<T>(env: Env, path: string, params?: Record<string, string | number>): Promise<PlexContainer<T>> {
  const { url, token } = baseUrl(env);
  const u = new URL(path, url + '/');
  u.searchParams.set('X-Plex-Token', token);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Plex ${res.status} on ${path}`);
  return res.json();
}

function epochToIso(sec?: number): string | null {
  return sec ? new Date(sec * 1000).toISOString() : null;
}

// Plex's newer agents attach a `Guid` array like [{id: "tvdb://121361"},
// {id: "imdb://tt0944947"}]; older ones only set the primary `guid` to
// something like "com.plexapp.agents.thetvdb://121361?lang=en". Either
// shape, or neither (an unmatched item's guid starts with "local://"),
// pull whatever looks like a TheTVDB numeric id out of it.
function extractTvdbId(m: PlexMetadata): string | null {
  const candidates = [...(m.Guid ?? []).map((g) => g.id), m.guid ?? ''];
  for (const c of candidates) {
    const match = /tvdb:\/\/(\d+)/.exec(c);
    if (match) return match[1];
  }
  return null;
}

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

function toRow(m: PlexMetadata, libraryId: string, parentId: string | null, syncedAt: string, overrides?: Partial<ItemRow>): ItemRow {
  return {
    id: m.ratingKey,
    library_id: libraryId,
    parent_id: parentId,
    type: m.type,
    title: m.title,
    sort_title: m.titleSort ?? null,
    year: m.year ?? null,
    season_number: m.parentIndex ?? null,
    episode_number: m.type === 'episode' || m.type === 'track' ? (m.index ?? null) : null,
    guid: m.guid ?? null,
    tvdb_id: m.type === 'show' ? extractTvdbId(m) : null,
    summary: m.summary ?? null,
    genres: (m.Genre ?? []).map((g) => g.tag).join(', ') || null,
    studio: m.studio ?? null,
    thumb_key: m.thumb ?? null,
    file_path: m.Media?.[0]?.Part?.[0]?.file ?? null,
    duration_ms: m.duration ?? null,
    added_at: epochToIso(m.addedAt),
    plex_updated_at: epochToIso(m.updatedAt),
    synced_at: syncedAt,
    ...overrides,
  };
}

// Derives one row per distinct season (for a show's episodes) or album
// (for an artist's tracks) seen among a batch of leaf items — Plex's
// `/allLeaves` never hands seasons/albums back directly, but every leaf
// names its own container via parentRatingKey/parentTitle/parentIndex.
function deriveContainerRows(
  leaves: PlexMetadata[],
  libraryId: string,
  containerType: 'season' | 'album',
  parentId: string,
  syncedAt: string
): ItemRow[] {
  const seen = new Map<string, ItemRow>();
  for (const leaf of leaves) {
    if (leaf.parentRatingKey && !seen.has(leaf.parentRatingKey)) {
      seen.set(leaf.parentRatingKey, {
        id: leaf.parentRatingKey,
        library_id: libraryId,
        parent_id: parentId,
        type: containerType,
        title: leaf.parentTitle ?? (containerType === 'season' ? `Season ${leaf.parentIndex ?? '?'}` : 'Unknown album'),
        sort_title: null,
        year: containerType === 'album' ? leaf.year ?? null : null,
        season_number: containerType === 'season' ? leaf.parentIndex ?? null : null,
        episode_number: null,
        guid: null,
        tvdb_id: null,
        summary: null,
        genres: null,
        studio: null,
        thumb_key: null,
        file_path: null,
        duration_ms: null,
        added_at: null,
        plex_updated_at: null,
        synced_at: syncedAt,
      });
    }
  }
  return [...seen.values()];
}

const UPSERT_SQL = `INSERT INTO plex_items (id, library_id, parent_id, type, title, sort_title, year, season_number, episode_number, guid, tvdb_id, summary, genres, studio, thumb_key, file_path, duration_ms, added_at, plex_updated_at, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET library_id=excluded.library_id, parent_id=excluded.parent_id, type=excluded.type, title=excluded.title, sort_title=excluded.sort_title, year=excluded.year, season_number=excluded.season_number, episode_number=excluded.episode_number, guid=excluded.guid, tvdb_id=excluded.tvdb_id, summary=excluded.summary, genres=excluded.genres, studio=excluded.studio, thumb_key=excluded.thumb_key, file_path=excluded.file_path, duration_ms=excluded.duration_ms, added_at=excluded.added_at, plex_updated_at=excluded.plex_updated_at, synced_at=excluded.synced_at`;

const BATCH_SIZE = 50; // D1's own per-batch statement ceiling has headroom above this; kept modest so one slow batch doesn't dominate a sync

// Upserts `rows` and returns how many D1 `.batch()` calls it made — each
// one counts as a subrequest against the invocation's budget, so the
// caller can track spend against SUBREQUEST_BUDGET_PER_CHUNK.
async function upsertRows(env: Env, rows: ItemRow[]): Promise<number> {
  let batches = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await env.DB.batch(
      chunk.map((r) =>
        env.DB.prepare(UPSERT_SQL).bind(
          r.id, r.library_id, r.parent_id, r.type, r.title, r.sort_title, r.year, r.season_number, r.episode_number,
          r.guid, r.tvdb_id, r.summary, r.genres, r.studio, r.thumb_key, r.file_path, r.duration_ms, r.added_at, r.plex_updated_at, r.synced_at
        )
      )
    );
    batches++;
  }
  return batches;
}

const PAGE_SIZE = 200;

// ---- Resumable state (migrations/0052_plex_sync_state.sql, singleton row id=1) ----

interface QueuedLibrary {
  key: string;
  title: string;
  type: string;
}

interface FinishedLibrary {
  id: string;
  title: string;
  itemCount: number;
}

interface SyncState {
  status: 'running' | 'done' | 'error';
  queue: QueuedLibrary[]; // libraries not yet started
  current: QueuedLibrary | null; // library in progress, if any
  currentItemCount: number;
  pendingParents: string[] | null; // show/artist ratingKeys still needing an /allLeaves fetch, for a show/artist library
  flatStart: number | null; // pagination cursor for a movie-shaped library
  librariesTotal: number;
  results: FinishedLibrary[];
  errorMessage?: string;
}

async function loadState(env: Env): Promise<SyncState | null> {
  const row = await env.DB.prepare('SELECT state_json FROM plex_sync_state WHERE id = 1').first<{ state_json: string }>();
  return row ? (JSON.parse(row.state_json) as SyncState) : null;
}

async function saveState(env: Env, state: SyncState): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO plex_sync_state (id, state_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(state), now)
    .run();
}

export interface SyncResult {
  libraries: FinishedLibrary[];
  totalItems: number;
}

export interface SyncChunkResult {
  done: boolean;
  progress: { library: string | null; librariesCompleted: number; librariesTotal: number; itemsSoFar: number };
  summary?: SyncResult;
}

// Stay well under Cloudflare's per-invocation subrequest cap (1000 on
// Workers Paid, 50 on the free plan) while still making real progress
// each chunk — counts every Plex fetch and every D1 `.batch()` call.
const SUBREQUEST_BUDGET_PER_CHUNK = 150;

/** Does one bounded slice of the full Plex library sync and returns
 * whether it's done. Safe to call repeatedly (including as the very
 * first call, which initializes fresh state) until `done` comes back
 * true — see the file header for why this is chunked at all. */
export async function runPlexSyncChunk(env: Env): Promise<SyncChunkResult> {
  let state = await loadState(env);
  const syncedAt = new Date().toISOString();
  let spent = 0; // subrequests made so far this chunk

  if (!state || state.status !== 'running') {
    const sections = await plexFetch<{ key: string; title: string; type: string }>(env, '/library/sections');
    spent++;
    const libs = (sections.MediaContainer.Directory ?? []).map((l) => ({ key: l.key, title: l.title, type: l.type }));
    state = {
      status: 'running',
      queue: libs,
      current: null,
      currentItemCount: 0,
      pendingParents: null,
      flatStart: null,
      librariesTotal: libs.length,
      results: [],
    };
  }

  while (spent < SUBREQUEST_BUDGET_PER_CHUNK) {
    if (!state.current) {
      const next = state.queue.shift();
      if (!next) {
        state.status = 'done';
        await saveState(env, state);
        return {
          done: true,
          progress: { library: null, librariesCompleted: state.results.length, librariesTotal: state.librariesTotal, itemsSoFar: totalItems(state) },
          summary: { libraries: state.results, totalItems: totalItems(state) },
        };
      }
      state.current = next;
      state.currentItemCount = 0;

      // plex_items.library_id is a foreign key into plex_libraries, so
      // this row has to exist before any item under it is upserted.
      await env.DB.prepare(
        `INSERT INTO plex_libraries (id, title, library_type, item_count, synced_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, library_type=excluded.library_type, synced_at=excluded.synced_at`
      )
        .bind(next.key, next.title, next.type, 0, syncedAt)
        .run();
      spent++;

      if (next.type === 'show' || next.type === 'artist') {
        const parents = await fetchAllPagedCounted(env, `/library/sections/${next.key}/all`, () => spent++);
        const rows = parents.map((p) => toRow(p, next.key, null, syncedAt));
        spent += await upsertRows(env, rows);
        state.currentItemCount += rows.length;
        state.pendingParents = parents.map((p) => p.ratingKey);
        state.flatStart = null;
      } else {
        state.pendingParents = null;
        state.flatStart = 0;
      }
    }

    const current = state.current;

    if (current.type === 'show' || current.type === 'artist') {
      if (!state.pendingParents || state.pendingParents.length === 0) {
        await finishCurrentLibrary(env, state);
        continue;
      }
      const ratingKey = state.pendingParents.shift()!;
      const leaves = await plexFetch<PlexMetadata>(env, `/library/metadata/${ratingKey}/allLeaves`);
      spent++;
      const children = leaves.MediaContainer.Metadata ?? [];
      if (children.length > 0) {
        const containerType = current.type === 'show' ? 'season' : 'album';
        const containerRows = deriveContainerRows(children, current.key, containerType, ratingKey, syncedAt);
        spent += await upsertRows(env, containerRows);
        const childRows = children.map((ch) => toRow(ch, current.key, ch.parentRatingKey ?? null, syncedAt));
        spent += await upsertRows(env, childRows);
        state.currentItemCount += containerRows.length + childRows.length;
      }
    } else {
      // Movies, and anything else Plex reports (photo libraries, or a
      // podcast/audiobook section under whatever type string this Plex
      // version uses) — synced flat, one page at a time so a huge flat
      // library also respects the chunk budget.
      const start = state.flatStart ?? 0;
      const page = await plexFetch<PlexMetadata>(env, `/library/sections/${current.key}/all`, {
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE_SIZE,
      });
      spent++;
      const items = page.MediaContainer.Metadata ?? [];
      if (items.length > 0) {
        const rows = items.map((it) => toRow(it, current.key, null, syncedAt));
        spent += await upsertRows(env, rows);
        state.currentItemCount += rows.length;
      }
      const total = page.MediaContainer.totalSize ?? page.MediaContainer.size ?? items.length;
      state.flatStart = start + items.length;
      if (items.length === 0 || state.flatStart >= total) {
        await finishCurrentLibrary(env, state);
      }
    }
  }

  await saveState(env, state);
  return {
    done: false,
    progress: {
      library: state.current?.title ?? null,
      librariesCompleted: state.results.length,
      librariesTotal: state.librariesTotal,
      itemsSoFar: totalItems(state),
    },
  };
}

function totalItems(state: SyncState): number {
  return state.results.reduce((sum, r) => sum + r.itemCount, 0) + state.currentItemCount;
}

async function finishCurrentLibrary(env: Env, state: SyncState): Promise<void> {
  if (!state.current) return;
  await env.DB.prepare(`UPDATE plex_libraries SET item_count = ? WHERE id = ?`).bind(state.currentItemCount, state.current.key).run();
  state.results.push({ id: state.current.key, title: state.current.title, itemCount: state.currentItemCount });
  state.current = null;
  state.pendingParents = null;
  state.flatStart = null;
}

// Same paging shape as the old fetchAllPaged, but reports each fetch to
// the caller's subrequest counter — used only for a show/artist
// library's initial /all listing (the shows/artists themselves, not
// their episodes/tracks), which is comparatively cheap even for a very
// large library since it's just titles, not full hierarchies.
async function fetchAllPagedCounted(env: Env, path: string, onFetch: () => void): Promise<PlexMetadata[]> {
  const out: PlexMetadata[] = [];
  let start = 0;
  for (;;) {
    const page = await plexFetch<PlexMetadata>(env, path, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE_SIZE });
    onFetch();
    const items = page.MediaContainer.Metadata ?? [];
    out.push(...items);
    const total = page.MediaContainer.totalSize ?? page.MediaContainer.size ?? items.length;
    start += items.length;
    if (items.length === 0 || start >= total) break;
  }
  return out;
}
