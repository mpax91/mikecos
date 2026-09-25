import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { BookmarksResponse } from '../../api/types';
import { ConfirmModal } from '../../components/ConfirmModal';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

/** Settings' management screen for the "Bookmarks" section on the Links
 * page (see worker/migrations/0060_bookmarks.sql) — a periodic, manual
 * mirror of a Chrome bookmarks export, not something synced live or
 * edited in place. Every import here fully replaces whatever's already
 * there: Chrome stays the source of truth, this is just the latest
 * snapshot of it, carried wherever MikeOS is opened. */
export function BookmarksImportPanel() {
  const [summary, setSummary] = useState<BookmarksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [justImported, setJustImported] = useState<{ folderCount: number; linkCount: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    api
      .listBookmarks()
      .then((res) => {
        setSummary(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setImportError(null);
    setJustImported(null);
    try {
      const result = await api.importBookmarks(file);
      setJustImported({ folderCount: result.folderCount, linkCount: result.linkCount });
      load();
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleClear() {
    setClearing(false);
    await api.clearBookmarks();
    setJustImported(null);
    load();
  }

  return (
    <div className="settings-page__section">
      <h2 className="settings-page__section-title">Bookmarks</h2>
      <p className="settings-page__section-hint">
        A periodic, manual mirror of your Chrome bookmarks — shown as a collapsed "Bookmarks" section under Quick
        Links on the Links page, folders and all. Chrome stays the source of truth: uploading a new export here
        completely replaces whatever's currently imported, it doesn't merge with it. In Chrome: ⋮ menu → Bookmarks
        and lists → Export bookmarks, then upload the .html file it saves.
      </p>

      {error && <div className="empty-state">Couldn't load bookmarks: {error}</div>}

      {summary && (
        <div className="bookmarks-import__status">
          {summary.linkCount > 0 ? (
            <>
              <strong>
                {summary.linkCount} bookmark{summary.linkCount === 1 ? '' : 's'} in {summary.folderCount} folder
                {summary.folderCount === 1 ? '' : 's'}
              </strong>
              {summary.lastImportedAt && <span> · last imported {formatRelativeTime(summary.lastImportedAt)}</span>}
            </>
          ) : (
            <span>No bookmarks imported yet.</span>
          )}
        </div>
      )}

      {justImported && (
        <div className="bookmarks-import__success">
          Imported {justImported.linkCount} bookmark{justImported.linkCount === 1 ? '' : 's'} in{' '}
          {justImported.folderCount} folder{justImported.folderCount === 1 ? '' : 's'}.
        </div>
      )}
      {importError && <div className="settings-page__rrule-error">{importError}</div>}

      <div className="bookmarks-import__actions">
        <label className="btn">
          {importing ? 'Importing…' : summary && summary.linkCount > 0 ? 'Import new export…' : 'Import bookmarks…'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".html,.htm,text/html"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            disabled={importing}
          />
        </label>
        {summary && summary.linkCount > 0 && (
          <button type="button" className="btn btn--ghost" onClick={() => setClearing(true)} disabled={importing}>
            Clear all bookmarks
          </button>
        )}
      </div>

      {clearing && (
        <ConfirmModal
          title="Clear all bookmarks?"
          body={`This removes all ${summary?.linkCount ?? 0} imported bookmarks from MikeOS. Your actual Chrome bookmarks are untouched — you can always re-import.`}
          onConfirm={handleClear}
          onCancel={() => setClearing(false)}
        />
      )}
    </div>
  );
}
