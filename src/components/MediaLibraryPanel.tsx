import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { PlexItem, PlexItemDetail, PlexLibrary, MediaCatalogItem, MediaCatalogFormat } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { KebabMenu } from './KebabMenu';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';

const CONTAINER_TYPES = new Set(['show', 'season', 'artist', 'album']);

// Search results get grouped into these sections rather than one flat
// alphabetical grid — a Plex-wide search can span every media type at
// once, and "Office" returning three TV shows, a movie, and forty
// episodes as one undifferentiated grid buries the shows Mike actually
// wants under everything that merely mentions them. Order deliberately
// puts the "top level" browsable things first (what you'd pick from a
// library root) and their children after (what you'd only get to by
// drilling in) — seasons are included for completeness even though a
// season rarely has a distinctive enough title to match a search.
const PLEX_SEARCH_SECTIONS: { type: string; label: string }[] = [
  { type: 'movie', label: 'Movies' },
  { type: 'show', label: 'TV Shows' },
  { type: 'artist', label: 'Artists' },
  { type: 'album', label: 'Albums' },
  { type: 'season', label: 'Seasons' },
  { type: 'episode', label: 'Episodes' },
  { type: 'track', label: 'Songs' },
  { type: 'item', label: 'Other' },
];
const SEARCH_SECTION_PAGE_SIZE = 12;

// Requested Plex poster size, in CSS px — the grid cell is smaller than
// this on purpose (retina headroom) but nowhere near Plex's own
// full-resolution art, which is what made the old grid feel slow: every
// tile was pulling down a multi-hundred-KB poster to show it at postage-
// stamp size. See plex.ts's /thumb/:id?w=&h= for the resize itself.
const THUMB_REQUEST_W = 160;
const THUMB_REQUEST_H = 240;

const FORMAT_LABEL: Record<MediaCatalogFormat, string> = {
  physical_book: 'Physical Book',
  ebook: 'eBook',
  audiobook: 'Audiobook',
};

type SourceScope = 'plex' | 'physical' | 'digital' | 'all';

function formatDuration(ms: number | null): string | null {
  if (!ms) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A single grouped-title entry — either a Plex item or a hand-entered
 * catalog item, tagged with enough to render and re-open it. Used only
 * by the "All" scope's search grouping (see groupByTitle). */
type UnifiedHit = { normTitle: string; label: string } & (
  | { kind: 'plex'; item: PlexItem }
  | { kind: 'catalog'; item: MediaCatalogItem }
);

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/^(the|a|an)\s+/, '');
}

/** Plex models an audiobook as Artist › Album (the book) › Track(s) (the
 * chapter files), same shape as music — but a single-file audiobook (no
 * chapter breakdown) has exactly one track, and Plex names that lone
 * track after the book itself. A title search then matches both the
 * book and its own only track, surfacing as two unexplained near-
 * identical hits for what's really one audiobook (see the "Network of
 * Lies" case this came from). Drop a track from a search result set when
 * its parent album is also in the set and shares its title — there's
 * nothing on the track tile Mike needs that the album tile doesn't
 * already cover. A track whose parent album didn't also match (a real
 * song search, or a multi-chapter book where only one chapter's title
 * happens to match) is left alone. */
function dedupeAudiobookTrackDuplicates(items: PlexItem[]): PlexItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.filter((i) => {
    if (i.type !== 'track') return true;
    const parent = i.parentId ? byId.get(i.parentId) : undefined;
    if (!parent || parent.type !== 'album') return true;
    return normalizeTitle(parent.title) !== normalizeTitle(i.title);
  });
}

/** Groups Plex + catalog search hits by normalized title so the same
 * work in multiple formats (a book Mike owns physical + audiobook +
 * ebook, say — or an audiobook that lives in Plex's own Audiobooks
 * library alongside a hand-entered physical/ebook copy) surfaces as one
 * heading with its instances listed underneath, rather than as several
 * identical-looking, unexplained duplicates. A title that only matched
 * once is left for the normal per-type rendering instead. */
function groupByTitle(hits: UnifiedHit[]): Map<string, UnifiedHit[]> {
  const byTitle = new Map<string, UnifiedHit[]>();
  for (const hit of hits) {
    const list = byTitle.get(hit.normTitle) ?? [];
    list.push(hit);
    byTitle.set(hit.normTitle, list);
  }
  for (const [key, list] of byTitle) {
    if (list.length < 2) byTitle.delete(key);
  }
  return byTitle;
}

/** The "Windows Explorer for my Plex library" view, now widened to the
 * whole Media section: pick a source (Plex / Physical / Digital / all
 * three), drill into shows/seasons or artists/albums, search across
 * everything. Deliberately just a browser for the Plex side: there's no
 * play/stream link anywhere here, on purpose (see the Plex feature
 * discussion this came out of — Mike wanted "do I have this" and "what's
 * wrong with it", not a player). Physical/digital are purely a catalog —
 * no read/listened status — added and edited from Settings by design;
 * this view can still edit/delete an entry inline for quick fixes. */
export function MediaLibraryPanel() {
  const location = useLocation();
  const [scope, setScope] = useState<SourceScope>('all');
  const [libraries, setLibraries] = useState<PlexLibrary[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; title: string }[]>([]);
  const [items, setItems] = useState<PlexItem[] | null>(null);
  const [catalogItems, setCatalogItems] = useState<MediaCatalogItem[] | null>(null);
  const [allPlexHits, setAllPlexHits] = useState<PlexItem[]>([]);
  const [allCatalogHits, setAllCatalogHits] = useState<MediaCatalogItem[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [detail, setDetail] = useState<PlexItemDetail | null>(null);
  const [catalogDetail, setCatalogDetail] = useState<MediaCatalogItem | null>(null);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<MediaCatalogItem | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogCounts, setCatalogCounts] = useState<Record<MediaCatalogFormat, number> | null>(null);

  const loadLibraries = useCallback(() => {
    api
      .listPlexLibraries()
      .then((libs) => {
        setLibraries(libs);
        if (!libraryId && libs.length) setLibraryId(libs[0].id);
      })
      .catch((e) => setError(String(e)));
  }, [libraryId]);

  // Whole-catalog counts for the Media landing page's stats row and the
  // Physical/Digital tabs' section totals — fetched once up front rather
  // than derived from whatever's currently filtered/searched, so these
  // numbers always reflect everything Mike's catalogued, not just what's
  // on screen right now.
  const loadCatalogCounts = useCallback(() => {
    api
      .listMediaCatalog({})
      .then((allItems) => {
        const counts: Record<MediaCatalogFormat, number> = { physical_book: 0, ebook: 0, audiobook: 0 };
        for (const item of allItems) counts[item.format] += 1;
        setCatalogCounts(counts);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadLibraries();
    loadCatalogCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landed here from a global search result (see SearchPalette/runSearch —
  // 'media' results carry either a bare Plex item id, or 'catalog:<id>'
  // for a hand-entered item, as openId) — jump straight to that item
  // rather than making Mike re-find it by browsing.
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId) return;
    if (openId.startsWith('catalog:')) {
      setScope('all');
      api.getMediaCatalogItem(openId.slice('catalog:'.length)).then(setCatalogDetail).catch((e) => setError(String(e)));
      return;
    }
    api.getPlexItem(openId).then(setDetail).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (scope === 'all') {
      if (!debouncedQuery) {
        setAllPlexHits([]);
        setAllCatalogHits([]);
        return;
      }
      Promise.all([api.listPlexItems({ q: debouncedQuery }), api.listMediaCatalog({ q: debouncedQuery })])
        .then(([plex, catalog]) => {
          setAllPlexHits(dedupeAudiobookTrackDuplicates(plex));
          setAllCatalogHits(catalog);
        })
        .catch((e) => setError(String(e)));
      return;
    }

    if (scope === 'physical' || scope === 'digital') {
      api
        .listMediaCatalog({ q: debouncedQuery || undefined, format: scope })
        .then(setCatalogItems)
        .catch((e) => setError(String(e)));
      return;
    }

    // scope === 'plex'
    if (debouncedQuery) {
      // Deliberately searches across every library, not just whichever
      // one is currently selected — Mike wants "do I have this anywhere"
      // rather than having to remember which tab something lives under.
      api
        .listPlexItems({ q: debouncedQuery })
        .then((plex) => setItems(dedupeAudiobookTrackDuplicates(plex)))
        .catch((e) => setError(String(e)));
      setExpandedSections(new Set());
      return;
    }
    if (!libraryId) return;
    // Audiobooks in Plex is structured like Music (author > book > chapter
    // tracks), so the normal root level would show authors first. Mike
    // reaches for the book title far more often, so at the root of a
    // library actually named "Audiobooks" this flattens straight to book
    // ("album") level instead — see the `type` param on listPlexItems.
    const isAudiobooks = !parentId && libraries?.find((l) => l.id === libraryId)?.title.trim().toLowerCase() === 'audiobooks';
    api
      .listPlexItems({ libraryId, parentId: parentId ?? undefined, type: isAudiobooks ? 'album' : undefined })
      .then(setItems)
      .catch((e) => setError(String(e)));
  }, [scope, libraryId, parentId, debouncedQuery, libraries]);

  function switchScope(next: SourceScope) {
    setScope(next);
    setParentId(null);
    setBreadcrumb([]);
    setQuery('');
  }

  function selectLibrary(id: string) {
    setLibraryId(id);
    setParentId(null);
    setBreadcrumb([]);
    setQuery('');
  }

  function openItem(item: PlexItem) {
    if (CONTAINER_TYPES.has(item.type)) {
      // A result clicked from a global search can belong to a different
      // library than whatever's currently selected — switch to it so the
      // breadcrumb and subsequent browsing stay correctly scoped, rather
      // than silently querying the old library for this item's children.
      const switchingLibrary = item.libraryId !== libraryId;
      setScope('plex');
      setLibraryId(item.libraryId);
      setParentId(item.id);
      setBreadcrumb((prev) => [...(switchingLibrary ? [] : prev), { id: item.id, title: item.title }]);
      setQuery('');
      return;
    }
    api.getPlexItem(item.id).then(setDetail).catch((e) => setError(String(e)));
  }

  function goToBreadcrumb(index: number) {
    if (index < 0) {
      setParentId(null);
      setBreadcrumb([]);
      return;
    }
    setParentId(breadcrumb[index].id);
    setBreadcrumb(breadcrumb.slice(0, index + 1));
  }

  function toggleSection(type: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function deleteCatalogItem(item: MediaCatalogItem) {
    await api.deleteMediaCatalogItem(item.id);
    setCatalogItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    setAllCatalogHits((prev) => prev.filter((i) => i.id !== item.id));
    if (catalogDetail?.id === item.id) setCatalogDetail(null);
    loadCatalogCounts();
  }

  // Only built (and only rendered) while searching in the Plex scope —
  // plain library browsing stays one flat grid, same as always, since
  // there's nothing to disambiguate when Mike's already inside one
  // library/level.
  const searchSections = scope === 'plex' && debouncedQuery
    ? PLEX_SEARCH_SECTIONS.map((s) => ({ ...s, items: (items ?? []).filter((i) => i.type === s.type) })).filter((s) => s.items.length > 0)
    : [];

  const unifiedGroups = useMemo(() => {
    if (scope !== 'all' || !debouncedQuery) return new Map<string, UnifiedHit[]>();
    const hits: UnifiedHit[] = [
      ...allPlexHits.map((item): UnifiedHit => ({ kind: 'plex', item, normTitle: normalizeTitle(item.title), label: item.title })),
      ...allCatalogHits.map((item): UnifiedHit => ({ kind: 'catalog', item, normTitle: normalizeTitle(item.title), label: item.title })),
    ];
    return groupByTitle(hits);
  }, [scope, debouncedQuery, allPlexHits, allCatalogHits]);

  const groupedIds = useMemo(() => {
    const plexIds = new Set<string>();
    const catalogIds = new Set<string>();
    for (const hits of unifiedGroups.values()) {
      for (const h of hits) {
        if (h.kind === 'plex') plexIds.add(h.item.id);
        else catalogIds.add(h.item.id);
      }
    }
    return { plexIds, catalogIds };
  }, [unifiedGroups]);

  // A large library syncs in several bounded chunks rather than one big
  // pass (see worker/src/plexSync.ts) — poll until the endpoint reports
  // done, showing progress in between so a long sync doesn't look stuck.
  async function handleSync() {
    setSyncing(true);
    setSyncMessage('Starting sync…');
    setError(null);
    try {
      for (;;) {
        const chunk = await api.syncPlexLibraryChunk();
        if (chunk.done) {
          const total = chunk.summary?.totalItems ?? chunk.progress.itemsSoFar;
          const libCount = chunk.summary?.libraries.length ?? chunk.progress.librariesTotal;
          setSyncMessage(`Synced ${total.toLocaleString()} items across ${libCount} librar${libCount === 1 ? 'y' : 'ies'}.`);
          break;
        }
        const { library, librariesCompleted, librariesTotal, itemsSoFar } = chunk.progress;
        setSyncMessage(
          `Syncing… library ${librariesCompleted + 1} of ${librariesTotal}${library ? ` (${library})` : ''} — ${itemsSoFar.toLocaleString()} items so far`
        );
      }
      loadLibraries();
      if (libraryId) api.listPlexItems({ libraryId, parentId: parentId ?? undefined }).then(setItems).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : "Couldn't sync — try again.");
    } finally {
      setSyncing(false);
    }
  }

  const activeLibrary = libraries?.find((l) => l.id === libraryId) ?? null;

  function renderPlexTile(item: PlexItem) {
    return (
      <button type="button" key={item.id} className="plex-tile" onClick={() => openItem(item)}>
        <div className="plex-tile__art">
          {item.thumbUrl ? (
            <img src={api.plexThumbUrl(item.id, THUMB_REQUEST_W, THUMB_REQUEST_H)} alt="" loading="lazy" />
          ) : (
            <span className="plex-tile__art-empty">{item.title.slice(0, 1)}</span>
          )}
          {!item.matched && (item.type === 'movie' || item.type === 'show' || item.type === 'episode') && (
            <span className="plex-tile__flag" title="Not matched to metadata">!</span>
          )}
        </div>
        <div className="plex-tile__title">
          {item.type === 'episode' && item.seasonNumber != null && item.episodeNumber != null
            ? `${String(item.seasonNumber).padStart(2, '0')}×${String(item.episodeNumber).padStart(2, '0')} — ${item.title}`
            : item.title}
        </div>
        {(item.year || debouncedQuery) && (
          <div className="plex-tile__meta">{debouncedQuery ? libraries?.find((l) => l.id === item.libraryId)?.title ?? '' : item.year}</div>
        )}
      </button>
    );
  }

  function renderCatalogRow(item: MediaCatalogItem) {
    return (
      <div className="media-catalog-row" key={item.id}>
        <button type="button" className="media-catalog-row__main" onClick={() => setCatalogDetail(item)}>
          <span className="media-catalog-row__title">{item.title}</span>
          {item.author && <span className="media-catalog-row__author">{item.author}</span>}
        </button>
        <span className={`media-catalog-row__format media-catalog-row__format--${item.format}`}>{FORMAT_LABEL[item.format]}</span>
        <KebabMenu
          items={[
            { label: 'View / Edit', onClick: () => setCatalogDetail(item) },
            { label: 'Delete', onClick: () => setConfirmDeleteItem(item), danger: true, separatorBefore: true },
          ]}
        />
      </div>
    );
  }

  function renderUnifiedHit(hit: UnifiedHit) {
    return hit.kind === 'plex' ? (
      <button type="button" key={`plex-${hit.item.id}`} className="media-grouped-hit" onClick={() => openItem(hit.item)}>
        <span className="media-grouped-hit__tag">{hit.item.type === 'album' ? 'Audiobook (Plex)' : 'Plex'}</span>
        {hit.item.year ? `${hit.item.title} (${hit.item.year})` : hit.item.title}
      </button>
    ) : (
      <button type="button" key={`catalog-${hit.item.id}`} className="media-grouped-hit" onClick={() => setCatalogDetail(hit.item)}>
        <span className="media-grouped-hit__tag">{FORMAT_LABEL[hit.item.format]}</span>
        {hit.item.title}
      </button>
    );
  }

  return (
    <div>
      <div className="plex-scope-chips">
        <button type="button" className={`plex-library-chip${scope === 'plex' ? ' is-active' : ''}`} onClick={() => switchScope('plex')}>
          Plex
        </button>
        <button type="button" className={`plex-library-chip${scope === 'physical' ? ' is-active' : ''}`} onClick={() => switchScope('physical')}>
          Physical
        </button>
        <button type="button" className={`plex-library-chip${scope === 'digital' ? ' is-active' : ''}`} onClick={() => switchScope('digital')}>
          Digital
        </button>
        <button type="button" className={`plex-library-chip${scope === 'all' ? ' is-active' : ''}`} onClick={() => switchScope('all')}>
          All
        </button>
      </div>

      {scope === 'plex' && (
        <div className="wallet-page__toolbar">
          <div className="wallet-editor__hint" style={{ flex: 1 }}>
            {activeLibrary?.syncedAt ? `Last synced ${formatRelativeTime(activeLibrary.syncedAt)}` : 'Not synced yet.'}
          </div>
          <button type="button" className="btn" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing… this can take a while' : 'Sync now'}
          </button>
        </div>
      )}

      {syncMessage && <div className="wallet-editor__hint" style={{ marginBottom: 8 }}>{syncMessage}</div>}
      {error && <div className="wallet-editor__error" style={{ marginBottom: 8 }}>{error}</div>}

      {scope === 'plex' && (
        !libraries ? (
          <div className="empty-state">Loading…</div>
        ) : libraries.length === 0 ? (
          <div className="empty-state">No libraries synced yet — hit "Sync now" once Plex is connected (see Settings).</div>
        ) : (
          <>
            <div className="plex-library-chips">
              {libraries.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`plex-library-chip${l.id === libraryId ? ' is-active' : ''}`}
                  onClick={() => selectLibrary(l.id)}
                >
                  {l.title} <span className="plex-library-chip__count">{l.itemCount.toLocaleString()}</span>
                </button>
              ))}
            </div>

            <div className="plex-browse__row">
              <div className="plex-breadcrumb">
                <button type="button" onClick={() => goToBreadcrumb(-1)} disabled={breadcrumb.length === 0 && !debouncedQuery}>
                  {activeLibrary?.title ?? 'Library'}
                </button>
                {breadcrumb.map((b, i) => (
                  <span key={b.id}>
                    <span className="plex-breadcrumb__sep">›</span>
                    <button type="button" onClick={() => goToBreadcrumb(i)}>
                      {b.title}
                    </button>
                  </span>
                ))}
              </div>
              <input className="plex-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all libraries…" />
            </div>

            {!items ? (
              <div className="empty-state">Loading…</div>
            ) : items.length === 0 ? (
              <div className="empty-state">Nothing here.</div>
            ) : debouncedQuery ? (
              <div className="plex-search-sections">
                {searchSections.map((section) => {
                  const isExpanded = expandedSections.has(section.type);
                  const shown = isExpanded ? section.items : section.items.slice(0, SEARCH_SECTION_PAGE_SIZE);
                  return (
                    <div className="plex-search-section" key={section.type}>
                      <div className="plex-search-section__title">
                        {section.label} <span className="plex-search-section__count">{section.items.length}</span>
                      </div>
                      <div className="plex-grid">{shown.map((item) => renderPlexTile(item))}</div>
                      {section.items.length > SEARCH_SECTION_PAGE_SIZE && !isExpanded && (
                        <button type="button" className="wallet-editor__manage-link" onClick={() => toggleSection(section.type)}>
                          See {section.items.length - SEARCH_SECTION_PAGE_SIZE} more {section.label.toLowerCase()}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="plex-grid">{items.map((item) => renderPlexTile(item))}</div>
            )}
          </>
        )
      )}

      {(scope === 'physical' || scope === 'digital') && (
        <>
          <div className="plex-browse__row">
            <div className="wallet-editor__hint" style={{ flex: 1 }}>
              {scope === 'physical' ? 'Physical books' : 'eBooks and audiobooks outside Plex'} — add or edit these from Settings › Media Catalog.
            </div>
            <input className="plex-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" />
          </div>

          {catalogCounts && (
            <div className="media-stats-row">
              <div className="media-stats-chip">
                {scope === 'physical' ? 'Physical' : 'Digital'}{' '}
                <strong>{(scope === 'physical' ? catalogCounts.physical_book : catalogCounts.ebook + catalogCounts.audiobook).toLocaleString()}</strong>
              </div>
            </div>
          )}
          {!catalogItems ? (
            <div className="empty-state">Loading…</div>
          ) : catalogItems.length === 0 ? (
            <div className="empty-state">Nothing catalogued yet — add one from Settings › Media Catalog.</div>
          ) : (
            <div className="media-catalog-list">{catalogItems.map((item) => renderCatalogRow(item))}</div>
          )}
        </>
      )}

      {scope === 'all' && (
        <>
          <div className="plex-browse__row">
            <input
              className="plex-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Plex, Physical, and Digital…"
              autoFocus
            />
          </div>

          {libraries && catalogCounts && (
            <div className="media-stats-row">
              {libraries.map((l) => (
                <div className="media-stats-chip" key={l.id}>
                  {l.title} <strong>{l.itemCount.toLocaleString()}</strong>
                </div>
              ))}
              <div className="media-stats-chip">
                eBooks <strong>{catalogCounts.ebook.toLocaleString()}</strong>
              </div>
              <div className="media-stats-chip">
                Physical Books <strong>{catalogCounts.physical_book.toLocaleString()}</strong>
              </div>
            </div>
          )}

          {!debouncedQuery ? (
            <div className="empty-state">Search to look across everything, or pick Plex, Physical, or Digital above to browse just one.</div>
          ) : unifiedGroups.size === 0 && allPlexHits.length === 0 && allCatalogHits.length === 0 ? (
            <div className="empty-state">Nothing found.</div>
          ) : (
            <div className="plex-search-sections">
              {unifiedGroups.size > 0 && (
                <div className="plex-search-section">
                  <div className="plex-search-section__title">
                    Multiple formats <span className="plex-search-section__count">{unifiedGroups.size}</span>
                  </div>
                  <div className="media-grouped-list">
                    {Array.from(unifiedGroups.entries()).map(([key, hits]) => (
                      <div className="media-grouped-group" key={key}>
                        <div className="media-grouped-group__title">{hits[0].label}</div>
                        <div className="media-grouped-group__hits">{hits.map((h) => renderUnifiedHit(h))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {allCatalogHits.filter((i) => !groupedIds.catalogIds.has(i.id)).length > 0 && (
                <div className="plex-search-section">
                  <div className="plex-search-section__title">
                    Physical &amp; Digital{' '}
                    <span className="plex-search-section__count">{allCatalogHits.filter((i) => !groupedIds.catalogIds.has(i.id)).length}</span>
                  </div>
                  <div className="media-catalog-list">
                    {allCatalogHits.filter((i) => !groupedIds.catalogIds.has(i.id)).map((item) => renderCatalogRow(item))}
                  </div>
                </div>
              )}

              {PLEX_SEARCH_SECTIONS.map((s) => {
                const sectionItems = allPlexHits.filter((i) => i.type === s.type && !groupedIds.plexIds.has(i.id));
                if (sectionItems.length === 0) return null;
                const isExpanded = expandedSections.has(`all-${s.type}`);
                const shown = isExpanded ? sectionItems : sectionItems.slice(0, SEARCH_SECTION_PAGE_SIZE);
                return (
                  <div className="plex-search-section" key={s.type}>
                    <div className="plex-search-section__title">
                      {s.label} <span className="plex-search-section__count">{sectionItems.length}</span>
                    </div>
                    <div className="plex-grid">{shown.map((item) => renderPlexTile(item))}</div>
                    {sectionItems.length > SEARCH_SECTION_PAGE_SIZE && !isExpanded && (
                      <button type="button" className="wallet-editor__manage-link" onClick={() => toggleSection(`all-${s.type}`)}>
                        See {sectionItems.length - SEARCH_SECTION_PAGE_SIZE} more {s.label.toLowerCase()}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 style={{ margin: 0 }}>{detail.title}</h3>
              <button type="button" className="modal__close" onClick={() => setDetail(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="wallet-editor__body">
              {detail.breadcrumb.length > 0 && (
                <div className="wallet-editor__hint">{detail.breadcrumb.map((b) => b.title).join(' › ')}</div>
              )}
              {detail.thumbUrl && (
                <img src={api.plexThumbUrl(detail.id)} alt="" style={{ width: '100%', maxWidth: 240, borderRadius: 8, marginBottom: 8 }} />
              )}
              {detail.summary && <p style={{ marginTop: 0 }}>{detail.summary}</p>}
              <div className="wallet-barcode-view__extra">
                {detail.year && (
                  <div className="wallet-barcode-view__extra-row">
                    <span>Year</span>
                    <span>{detail.year}</span>
                  </div>
                )}
                {detail.genres.length > 0 && (
                  <div className="wallet-barcode-view__extra-row">
                    <span>Genres</span>
                    <span>{detail.genres.join(', ')}</span>
                  </div>
                )}
                {detail.studio && (
                  <div className="wallet-barcode-view__extra-row">
                    <span>Studio</span>
                    <span>{detail.studio}</span>
                  </div>
                )}
                {detail.durationMs && (
                  <div className="wallet-barcode-view__extra-row">
                    <span>Duration</span>
                    <span>{formatDuration(detail.durationMs)}</span>
                  </div>
                )}
                <div className="wallet-barcode-view__extra-row">
                  <span>Matched</span>
                  <span>{detail.matched ? 'Yes' : 'No — Plex hasn’t identified this one'}</span>
                </div>
                {detail.filePath && (
                  <div className="wallet-barcode-view__extra-row">
                    <span>File</span>
                    <span style={{ wordBreak: 'break-all', fontSize: 11.5 }}>{detail.filePath}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {catalogDetail && (
        <CatalogItemModal
          item={catalogDetail}
          onClose={() => setCatalogDetail(null)}
          onSaved={(updated) => {
            setCatalogDetail(updated);
            setCatalogItems((prev) => (prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev));
            setAllCatalogHits((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
            loadCatalogCounts(); // a format edit (e.g. ebook -> physical) moves it between Physical and Digital's totals
          }}
          onDeleted={() => {
            setConfirmDeleteItem(catalogDetail);
            setCatalogDetail(null);
          }}
        />
      )}

      {confirmDeleteItem && (
        <ConfirmModal
          title="Remove this item?"
          body={`"${confirmDeleteItem.title}" will be removed from the catalog.`}
          onConfirm={() => {
            deleteCatalogItem(confirmDeleteItem);
            setConfirmDeleteItem(null);
          }}
          onCancel={() => setConfirmDeleteItem(null)}
        />
      )}
    </div>
  );
}

/** Quick view/edit for one catalog entry — reachable from the Physical/
 * Digital list, a grouped "All" search hit, or the global search
 * palette. Adding brand-new entries stays in Settings (see MediaPage's
 * header comment); this is just for fixing a typo or format on one
 * that's already there without a trip to Settings. */
function CatalogItemModal({
  item,
  onClose,
  onSaved,
  onDeleted,
}: {
  item: MediaCatalogItem;
  onClose: () => void;
  onSaved: (item: MediaCatalogItem) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [author, setAuthor] = useState(item.author ?? '');
  const [format, setFormat] = useState<MediaCatalogFormat>(item.format);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateMediaCatalogItem(item.id, {
        title: title.trim(),
        author: author.trim() || null,
        format,
        notes: notes.trim() || null,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : "Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit catalog item" onClose={onClose}>
      <div className="wallet-editor__body">
        <label className="wallet-editor__field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="wallet-editor__field">
          <span>Author</span>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label className="wallet-editor__field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as MediaCatalogFormat)}>
            {(Object.keys(FORMAT_LABEL) as MediaCatalogFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
        {error && <div className="wallet-editor__error">{error}</div>}
      </div>

      <div className="modal__actions">
        <button type="button" className="btn btn--danger" onClick={onDeleted}>
          Delete
        </button>
        <button type="button" className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
