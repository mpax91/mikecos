import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { PlexItem, PlexItemDetail, PlexLibrary } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';

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

function formatDuration(ms: number | null): string | null {
  if (!ms) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The "Windows Explorer for my Plex library" view — pick a library,
 * drill into shows/seasons or artists/albums, search across everything.
 * Deliberately just a browser: there's no play/stream link anywhere here,
 * on purpose (see the Plex feature discussion this came out of — Mike
 * wanted "do I have this" and "what's wrong with it", not a player). */
export function PlexLibraryPanel() {
  const location = useLocation();
  const [libraries, setLibraries] = useState<PlexLibrary[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; title: string }[]>([]);
  const [items, setItems] = useState<PlexItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [detail, setDetail] = useState<PlexItemDetail | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLibraries = useCallback(() => {
    api
      .listPlexLibraries()
      .then((libs) => {
        setLibraries(libs);
        if (!libraryId && libs.length) setLibraryId(libs[0].id);
      })
      .catch((e) => setError(String(e)));
  }, [libraryId]);

  useEffect(() => {
    loadLibraries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landed here from a global search result (see SearchPalette/runSearch —
  // 'plex' results carry the item's own id as openId) — jump straight to
  // that item's detail modal rather than making Mike re-find it by browsing.
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId) return;
    api.getPlexItem(openId).then(setDetail).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (debouncedQuery) {
      // Deliberately searches across every library, not just whichever
      // one is currently selected — Mike wants "do I have this anywhere"
      // rather than having to remember which tab something lives under.
      api.listPlexItems({ q: debouncedQuery }).then(setItems).catch((e) => setError(String(e)));
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
  }, [libraryId, parentId, debouncedQuery, libraries]);

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

  // Only built (and only rendered) while searching — plain library
  // browsing stays one flat grid, same as always, since there's nothing
  // to disambiguate when Mike's already inside one library/level.
  const searchSections = debouncedQuery
    ? PLEX_SEARCH_SECTIONS.map((s) => ({ ...s, items: (items ?? []).filter((i) => i.type === s.type) })).filter((s) => s.items.length > 0)
    : [];

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
          {item.thumbUrl ? <img src={api.plexThumbUrl(item.id)} alt="" loading="lazy" /> : <span className="plex-tile__art-empty">{item.title.slice(0, 1)}</span>}
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

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-editor__hint" style={{ flex: 1 }}>
          {activeLibrary?.syncedAt ? `Last synced ${formatRelativeTime(activeLibrary.syncedAt)}` : 'Not synced yet.'}
        </div>
        <button type="button" className="btn" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing… this can take a while' : 'Sync now'}
        </button>
      </div>

      {syncMessage && <div className="wallet-editor__hint" style={{ marginBottom: 8 }}>{syncMessage}</div>}
      {error && <div className="wallet-editor__error" style={{ marginBottom: 8 }}>{error}</div>}

      {!libraries ? (
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
    </div>
  );
}
