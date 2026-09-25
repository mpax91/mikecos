import type { Env } from './types';

/** Talks to Mike's own Plex Media Server (never plex.tv) and mirrors its
 * catalogue into D1 — see migrations/0051_plex.sql for why this is a
 * synced copy rather than live-querying Plex on every page load. Plex's
 * API is JSON when asked nicely (`Accept: application/json`); every
 * response is wrapped in a top-level `MediaContainer`. */

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

const UPSERT_SQL = `INSERT INTO plex_items (id, library_id, parent_id, type, title, sort_title, year, season_number, episode_number, guid, tvdb_id, summary, genres, studio, thumb_key, file_path, duration_ms, added_at, plex_updated_at, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET library_id=excluded.library_id, parent_id=excluded.parent_id, type=excluded.type, title=excluded.title, sort_title=excluded.sort_title, year=excluded.year, season_number=excluded.season_number, episode_number=excluded.episode_number, guid=excluded.guid, tvdb_id=excluded.tvdb_id, summary=excluded.summary, genres=excluded.genres, studio=excluded.studio, thumb_key=excluded.thumb_key, file_path=excluded.file_path, duration_ms=excluded.duration_ms, added_at=excluded.added_at, plex_updated_at=excluded.plex_updated_at, synced_at=excluded.synced_at`;

const BATCH_SIZE = 50; // D1's own per-batch statement ceiling has headroom above this; kept modest so one slow batch doesn't dominate a sync

async function upsertRows(env: Env, rows: ItemRow[]): Promise<void> {
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
  }
}

const PAGE_SIZE = 200;

// Fetches every item under a section's flat `/all` (movies, or any
// section type MikeOS doesn't have special hierarchy handling for), one
// page at a time.
async function fetchAllPaged(env: Env, path: string): Promise<PlexMetadata[]> {
  const out: PlexMetadata[] = [];
  let start = 0;
  for (;;) {
    const page = await plexFetch<PlexMetadata>(env, path, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE_SIZE });
    const items = page.MediaContainer.Metadata ?? [];
    out.push(...items);
    const total = page.MediaContainer.totalSize ?? page.MediaContainer.size ?? items.length;
    start += items.length;
    if (items.length === 0 || start >= total) break;
  }
  return out;
}

export interface SyncResult {
  libraries: { id: string; title: string; itemCount: number }[];
  totalItems: number;
}

/** Full re-sync of every Plex library section. Movie-shaped (and any
 * section MikeOS doesn't recognize) libraries sync as a single flat
 * `/all` pull. Show libraries sync shows via `/all`, then every episode
 * for each show in one call via `/allLeaves` (far cheaper than walking
 * season-by-season) — seasons are derived from the episodes themselves
 * rather than fetched separately. Music libraries mirror that shape one
 * level down: artists via `/all`, tracks (and derived albums) via
 * `/allLeaves` per artist. */
export async function syncPlexLibrary(env: Env): Promise<SyncResult> {
  const syncedAt = new Date().toISOString();
  const sections = await plexFetch<{ key: string; title: string; type: string }>(env, '/library/sections');
  const libraries = sections.MediaContainer.Directory ?? [];
  const results: SyncResult['libraries'] = [];
  let totalItems = 0;

  for (const lib of libraries) {
    const libraryId = lib.key;
    let itemCount = 0;

    if (lib.type === 'show') {
      const shows = await fetchAllPaged(env, `/library/sections/${libraryId}/all`);
      const showRows = shows.map((s) => toRow(s, libraryId, null, syncedAt));
      await upsertRows(env, showRows);
      itemCount += showRows.length;

      for (const show of shows) {
        const leaves = await plexFetch<PlexMetadata>(env, `/library/metadata/${show.ratingKey}/allLeaves`);
        const episodes = leaves.MediaContainer.Metadata ?? [];
        if (episodes.length === 0) continue;

        // Derive one season row per distinct parentRatingKey seen among
        // this show's episodes — Plex never hands seasons back directly
        // from allLeaves, but every episode names its own season.
        const seasonsSeen = new Map<string, ItemRow>();
        for (const ep of episodes) {
          if (ep.parentRatingKey && !seasonsSeen.has(ep.parentRatingKey)) {
            seasonsSeen.set(ep.parentRatingKey, {
              id: ep.parentRatingKey,
              library_id: libraryId,
              parent_id: show.ratingKey,
              type: 'season',
              title: ep.parentTitle ?? `Season ${ep.parentIndex ?? '?'}`,
              sort_title: null,
              year: null,
              season_number: ep.parentIndex ?? null,
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
        await upsertRows(env, [...seasonsSeen.values()]);
        const episodeRows = episodes.map((ep) => toRow(ep, libraryId, ep.parentRatingKey ?? null, syncedAt));
        await upsertRows(env, episodeRows);
        itemCount += seasonsSeen.size + episodeRows.length;
      }
    } else if (lib.type === 'artist') {
      const artists = await fetchAllPaged(env, `/library/sections/${libraryId}/all`);
      const artistRows = artists.map((a) => toRow(a, libraryId, null, syncedAt));
      await upsertRows(env, artistRows);
      itemCount += artistRows.length;

      for (const artist of artists) {
        const leaves = await plexFetch<PlexMetadata>(env, `/library/metadata/${artist.ratingKey}/allLeaves`);
        const tracks = leaves.MediaContainer.Metadata ?? [];
        if (tracks.length === 0) continue;

        const albumsSeen = new Map<string, ItemRow>();
        for (const tr of tracks) {
          if (tr.parentRatingKey && !albumsSeen.has(tr.parentRatingKey)) {
            albumsSeen.set(tr.parentRatingKey, {
              id: tr.parentRatingKey,
              library_id: libraryId,
              parent_id: artist.ratingKey,
              type: 'album',
              title: tr.parentTitle ?? 'Unknown album',
              sort_title: null,
              year: tr.year ?? null,
              season_number: null,
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
        await upsertRows(env, [...albumsSeen.values()]);
        const trackRows = tracks.map((tr) => toRow(tr, libraryId, tr.parentRatingKey ?? null, syncedAt));
        await upsertRows(env, trackRows);
        itemCount += albumsSeen.size + trackRows.length;
      }
    } else {
      // Movies, and anything else Plex reports (photo libraries, or a
      // podcast/audiobook section under whatever type string this Plex
      // version uses) — synced flat. If a particular library type turns
      // out to need its own hierarchy handling once real data is seen,
      // it gets its own branch above the same way show/artist did.
      const items = await fetchAllPaged(env, `/library/sections/${libraryId}/all`);
      const rows = items.map((it) => toRow(it, libraryId, null, syncedAt));
      await upsertRows(env, rows);
      itemCount += rows.length;
    }

    await env.DB.prepare(
      `INSERT INTO plex_libraries (id, title, library_type, item_count, synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, library_type=excluded.library_type, item_count=excluded.item_count, synced_at=excluded.synced_at`
    )
      .bind(libraryId, lib.title, lib.type, itemCount, syncedAt)
      .run();

    results.push({ id: libraryId, title: lib.title, itemCount });
    totalItems += itemCount;
  }

  return { libraries: results, totalItems };
}
