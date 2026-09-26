import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { api } from '../api/client';
import type { CloudAccount, CloudFileEntry, CloudSearchHit } from '../api/types';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

function quotaFraction(acct: CloudAccount): number | null {
  if (!acct.quota || !acct.quota.totalBytes) return null;
  return Math.min(1, acct.quota.usedBytes / acct.quota.totalBytes);
}

interface Crumb {
  id: string | null; // null = this account's root
  name: string;
}

/** One file or folder row inside the browse view — a folder navigates in on
 * click; a file gets inline Open (the provider's own web viewer, when it
 * has one) / Download actions rather than a click-through, since there's
 * nothing further to drill into. */
function EntryRow({ entry, account, onOpenFolder }: { entry: CloudFileEntry; account: CloudAccount; onOpenFolder: (entry: CloudFileEntry) => void }) {
  if (entry.type === 'folder') {
    return (
      <button type="button" className="cloud-tree__row cloud-tree__row--folder" onClick={() => onOpenFolder(entry)}>
        <span className="cloud-tree__icon">📁</span>
        <span className="cloud-tree__name">{entry.name}</span>
        <span className="cloud-tree__meta">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString() : ''}</span>
      </button>
    );
  }
  return (
    <div className="cloud-tree__row">
      <span className="cloud-tree__icon">📄</span>
      <span className="cloud-tree__name">{entry.name}</span>
      <span className="cloud-tree__meta">{formatBytes(entry.sizeBytes)}</span>
      <span className="cloud-tree__actions">
        {entry.webUrl && (
          <a className="btn btn--icon btn--sm" href={entry.webUrl} target="_blank" rel="noopener noreferrer" title="Open">
            ↗
          </a>
        )}
        <a
          className="btn btn--icon btn--sm"
          href={api.cloudDownloadUrl(account.id, entry.id, entry.name)}
          title="Download"
        >
          ⬇
        </a>
      </span>
    </div>
  );
}

function SearchResultRow({ hit }: { hit: CloudSearchHit }) {
  return (
    <div className="cloud-tree__row cloud-search__row">
      <span className="cloud-tree__icon">{hit.type === 'folder' ? '📁' : '📄'}</span>
      <span className="cloud-tree__name">
        {hit.name}
        <span className="cloud-search__context">
          {hit.accountLabel}
          {hit.path ? ` · ${hit.path}` : ''}
        </span>
      </span>
      <span className="cloud-tree__actions">
        {hit.webUrl && (
          <a className="btn btn--icon btn--sm" href={hit.webUrl} target="_blank" rel="noopener noreferrer" title="Open">
            ↗
          </a>
        )}
        {hit.type === 'file' && (
          <a className="btn btn--icon btn--sm" href={api.cloudDownloadUrl(hit.accountId, hit.id, hit.name)} title="Download">
            ⬇
          </a>
        )}
      </span>
    </div>
  );
}

/** Cloud — a live, read-only Windows-Explorer-style view over every
 * connected cloud storage account (Google Drive/OneDrive/Dropbox/Box).
 * Nothing here is imported or cached the way Bookmarks is: every folder
 * view and search hits the provider directly through worker/src/cloud.ts,
 * using that account's stored OAuth tokens. Connecting/disconnecting
 * accounts happens in Settings → Cloud Storage. */
export function CloudPage() {
  useReportTabMeta('Cloud', 'cloud');
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<CloudFileEntry[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CloudSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<number | null>(null);

  useEffect(() => {
    api
      .listCloudAccounts()
      .then(setAccounts)
      .catch((e) => setError(String(e)));
  }, []);

  const loadFolder = useCallback((acct: CloudAccount, folderId: string | null) => {
    setEntries(null);
    setBrowseError(null);
    api
      .browseCloud(acct.id, folderId)
      .then((res) => setEntries(res.entries))
      .catch((e) => setBrowseError(String(e)));
  }, []);

  function openAccount(acct: CloudAccount) {
    setAccount(acct);
    setCrumbs([{ id: null, name: acct.label }]);
    loadFolder(acct, null);
  }

  function openFolder(entry: CloudFileEntry) {
    if (!account) return;
    setCrumbs((c) => [...c, { id: entry.id, name: entry.name }]);
    loadFolder(account, entry.id);
  }

  function jumpToCrumb(index: number) {
    if (!account) return;
    const next = crumbs.slice(0, index + 1);
    setCrumbs(next);
    loadFolder(account, next[next.length - 1].id);
  }

  function backToAccounts() {
    setAccount(null);
    setCrumbs([]);
    setEntries(null);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (searchDebounce.current) window.clearTimeout(searchDebounce.current);
    if (!value.trim()) {
      setSearchResults(null);
      return;
    }
    searchDebounce.current = window.setTimeout(() => {
      setSearching(true);
      api
        .searchCloud(value.trim())
        .then((res) => setSearchResults(res.results))
        .catch((e) => setBrowseError(String(e)))
        .finally(() => setSearching(false));
    }, 400);
  }

  if (error) return <div className="empty-state">Couldn't load Cloud Storage: {error}</div>;
  if (!accounts) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
        Cloud
      </h1>
      <p className="links-page__subhead">Your real cloud storage accounts, in one place — click in to browse, or search across all of them.</p>

      {accounts.length === 0 ? (
        <div className="empty-state">
          No cloud storage accounts connected yet — connect one in{' '}
          <Link to="/settings?cat=cloud">Settings → Cloud Storage</Link>.
        </div>
      ) : (
        <>
          <input
            type="search"
            className="cloud-page__search"
            placeholder="Search across every connected account…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
          />

          {query.trim() ? (
            <div className="cloud-tree">
              {searching && <div className="empty-state empty-state--section">Searching…</div>}
              {!searching && searchResults && searchResults.length === 0 && <div className="empty-state empty-state--section">No matches.</div>}
              {!searching && searchResults?.map((hit) => <SearchResultRow key={`${hit.accountId}:${hit.id}`} hit={hit} />)}
            </div>
          ) : !account ? (
            <div className="cloud-page__tiles">
              {accounts.map((acct) => {
                const frac = quotaFraction(acct);
                return (
                  <button type="button" key={acct.id} className="cloud-tile" onClick={() => openAccount(acct)} style={{ '--cloud-tile-color': acct.color } as React.CSSProperties}>
                    <span className="cloud-tile__icon">{acct.icon}</span>
                    <span className="cloud-tile__label">{acct.label}</span>
                    <span className="cloud-tile__provider">{acct.providerLabel}</span>
                    {acct.status === 'error' ? (
                      <span className="cloud-tile__error">⚠ Reconnect in Settings</span>
                    ) : acct.quota ? (
                      <div className="cloud-tile__quota">
                        <div className="cloud-tile__quota-bar">
                          {frac !== null && <div className="cloud-tile__quota-fill" style={{ width: `${frac * 100}%` }} />}
                        </div>
                        <span>
                          {formatBytes(acct.quota.usedBytes)}
                          {acct.quota.totalBytes ? ` / ${formatBytes(acct.quota.totalBytes)}` : ' used'}
                        </span>
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <div className="cloud-page__breadcrumbs">
                <button type="button" onClick={backToAccounts}>
                  Cloud
                </button>
                {crumbs.map((crumb, i) => (
                  <span key={i}>
                    <span className="cloud-page__crumb-sep">›</span>
                    <button type="button" onClick={() => jumpToCrumb(i)} disabled={i === crumbs.length - 1}>
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>

              {browseError && <div className="empty-state">{browseError}</div>}
              {!browseError && !entries && <div className="empty-state empty-state--section">Loading…</div>}
              {!browseError && entries && entries.length === 0 && <div className="empty-state empty-state--section">Empty folder.</div>}
              {!browseError && entries && entries.length > 0 && (
                <div className="cloud-tree">
                  {entries.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} account={account} onOpenFolder={openFolder} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
