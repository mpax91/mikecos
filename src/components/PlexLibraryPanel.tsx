import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PlexItem, PlexItemDetail, PlexLibrary } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';

const CONTAINER_TYPES = new Set(['show', 'season', 'artist', 'album']);

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
  const [libraries, setLibraries] = useState<PlexLibrary[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; title: string }[]>([]);
  const [items, setItems] = useState<PlexItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [detail, setDetail] = useState<PlexItemDetail | null>(null);
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

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (debouncedQuery) {
      api.listPlexItems({ q: debouncedQuery, libraryId: libraryId ?? undefined }).then(setItems).catch((e) => setError(String(e)));
      return;
    }
    if (!libraryId) return;
    api.listPlexItems({ libraryId, parentId: parentId ?? undefined }).then(setItems).catch((e) => setError(String(e)));
  }, [libraryId, parentId, debouncedQuery]);

  function selectLibrary(id: string) {
    setLibraryId(id);
    setParentId(null);
    setBreadcrumb([]);
    setQuery('');
  }

  function openItem(item: PlexItem) {
    if (CONTAINER_TYPES.has(item.type)) {
      setParentId(item.id);
      setBreadcrumb((prev) => [...prev, { id: item.id, title: item.title }]);
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

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const result = await api.syncPlexLibrary();
      setSyncMessage(`Synced ${result.totalItems.toLocaleString()} items across ${result.libraries.length} librar${result.libraries.length === 1 ? 'y' : 'ies'}.`);
      loadLibraries();
      if (libraryId) api.listPlexItems({ libraryId, parentId: parentId ?? undefined }).then(setItems).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : "Couldn't sync — try again.");
    } finally {
      setSyncing(false);
    }
  }

  const activeLibrary = libraries?.find((l) => l.id === libraryId) ?? null;

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
            <input className="plex-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this library…" />
          </div>

          {!items ? (
            <div className="empty-state">Loading…</div>
          ) : items.length === 0 ? (
            <div className="empty-state">Nothing here.</div>
          ) : (
            <div className="plex-grid">
              {items.map((item) => (
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
                  {item.year && <div className="plex-tile__meta">{item.year}</div>}
                </button>
              ))}
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
    </div>
  );
}
