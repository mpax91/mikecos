import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { NewsFeed, NewsFolder } from '../../api/types';
import { ConfirmModal } from '../../components/ConfirmModal';

const AUTO_READ_DEFAULT_HOURS = 48;

/** News Feeds — add/edit/remove RSS feeds and their folder. Used to live as
 * a "Manage Feeds" modal launched from the News page itself; moved here
 * because it's only going to get more to manage (folders, sources) and a
 * popup felt like the wrong home for that — News itself just keeps a gear
 * icon that deep-links to this panel (see NewsPage.tsx's link to
 * `/settings?cat=news-feeds` and SettingsPage's `?cat=` handling). */
export function NewsFeedsPanel() {
  const [feeds, setFeeds] = useState<NewsFeed[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { title: string; folder: string }>>({});
  const [confirmDelete, setConfirmDelete] = useState<NewsFeed | null>(null);

  // Folder order — see worker/migrations/0064_news_folders.sql. `folders`
  // is just the ordered list of names /api/news/folders returns (already
  // sorted: explicitly-positioned ones first, everything else alphabetical
  // after them); reordering swaps two entries locally and PUTs the whole
  // list back, rather than tracking sortOrder per-row like Wallet
  // Categories does — folder names aren't real rows anywhere else, so
  // there's no id to key a partial update off of.
  const [folders, setFolders] = useState<NewsFolder[] | null>(null);
  const [reorderingFolders, setReorderingFolders] = useState(false);

  // Auto-mark-as-read: articles older than this many hours silently clear
  // out of the unread feed on their own. `autoReadEnabled` toggles the
  // checkbox; `autoReadHours` is the number field, only meaningful while
  // enabled — kept separate so unchecking the box doesn't lose whatever
  // number was typed in.
  const [autoReadEnabled, setAutoReadEnabled] = useState(false);
  const [autoReadHours, setAutoReadHours] = useState(AUTO_READ_DEFAULT_HOURS);
  const [autoReadSaved, setAutoReadSaved] = useState(true);
  const autoReadSaveTimer = useRef<number | null>(null);

  function load() {
    api
      .listNewsFeeds()
      .then((list) => {
        setFeeds(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  function loadFolders() {
    api.listNewsFolders().then(setFolders);
  }

  useEffect(() => {
    load();
    loadFolders();
    api.getNewsSettings().then((s) => {
      setAutoReadEnabled(s.auto_read_hours != null);
      if (s.auto_read_hours != null) setAutoReadHours(s.auto_read_hours);
    });
  }, []);

  async function moveFolder(folder: NewsFolder, dir: -1 | 1) {
    if (!folders) return;
    const i = folders.findIndex((f) => f.name === folder.name);
    const j = i + dir;
    if (j < 0 || j >= folders.length) return;
    const next = [...folders];
    [next[i], next[j]] = [next[j], next[i]];
    setReorderingFolders(true);
    setFolders(next);
    try {
      await api.reorderNewsFolders(next.map((f) => f.name));
      load(); // feed folder-groups on the News page follow this same order
    } finally {
      setReorderingFolders(false);
    }
  }

  useEffect(
    () => () => {
      if (autoReadSaveTimer.current != null) window.clearTimeout(autoReadSaveTimer.current);
    },
    []
  );

  function saveAutoRead(enabled: boolean, hours: number) {
    setAutoReadSaved(false);
    if (autoReadSaveTimer.current != null) window.clearTimeout(autoReadSaveTimer.current);
    autoReadSaveTimer.current = window.setTimeout(() => {
      api.updateNewsSettings(enabled ? hours : null).then(() => setAutoReadSaved(true));
    }, 500);
  }

  function toggleAutoRead(enabled: boolean) {
    setAutoReadEnabled(enabled);
    saveAutoRead(enabled, autoReadHours);
  }

  function changeAutoReadHours(hours: number) {
    setAutoReadHours(hours);
    if (autoReadEnabled) saveAutoRead(true, hours);
  }

  const existingFolders = [...new Set((feeds ?? []).map((f) => f.folder).filter((f): f is string => !!f))].sort();

  async function addFeed() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    setAddError(null);
    try {
      const feed = await api.addNewsFeed(trimmed, folder.trim() || null);
      if ((feed as unknown as { error?: string }).error) {
        setAddError((feed as unknown as { error: string }).error);
      } else {
        setUrl('');
        setFolder('');
      }
      load();
      loadFolders();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add that feed.');
    } finally {
      setAdding(false);
    }
  }

  function startEdit(feed: NewsFeed) {
    setEditing((e) => ({ ...e, [feed.id]: { title: feed.title, folder: feed.folder ?? '' } }));
  }

  async function saveEdit(feed: NewsFeed) {
    const draft = editing[feed.id];
    if (!draft) return;
    await api.updateNewsFeed(feed.id, { title: draft.title.trim() || feed.title, folder: draft.folder.trim() || null });
    setEditing((e) => {
      const next = { ...e };
      delete next[feed.id];
      return next;
    });
    load();
    loadFolders();
  }

  async function deleteFeed(feed: NewsFeed) {
    await api.deleteNewsFeed(feed.id);
    setConfirmDelete(null);
    load();
    loadFolders();
  }

  if (error) return <div className="empty-state">Couldn't load feeds: {error}</div>;
  if (!feeds) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Reading</h2>
      </div>
      <p className="settings-page__section-hint">
        Automatically mark articles as read once they've been sitting unread for a while, so the feed doesn't turn
        into an unmanageable backlog. Anything you actually read stays out of this — it only clears articles you
        never opened.
      </p>
      <label className="settings-page__checkbox-row">
        <input type="checkbox" checked={autoReadEnabled} onChange={(e) => toggleAutoRead(e.target.checked)} />
        Auto-mark as read after
        <input
          type="number"
          min={1}
          className="news-feeds-modal__row-input"
          style={{ width: 56 }}
          value={autoReadHours}
          disabled={!autoReadEnabled}
          onChange={(e) => changeAutoReadHours(Math.max(1, Number(e.target.value) || 1))}
        />
        hours
      </label>
      {!autoReadSaved && <p className="settings-page__section-hint">Saving…</p>}

      <div className="toolbar-row" style={{ marginTop: 28 }}>
        <h2 className="settings-page__section-title">Folder Order</h2>
      </div>
      <p className="settings-page__section-hint">
        Controls where each folder sits underneath "All" in News' sidebar. Uncategorized always sorts last and isn't
        listed here.
      </p>
      {!folders ? (
        <p className="settings-page__section-hint">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="settings-page__section-hint">No folders yet — give a feed below a folder name to create one.</p>
      ) : (
        <div className="manage-list">
          {folders.map((f, i) => (
            <div className="manage-row" key={f.name}>
              <div className="manage-row__move">
                <button type="button" disabled={i === 0 || reorderingFolders} onClick={() => moveFolder(f, -1)} title="Move up">
                  ▲
                </button>
                <button
                  type="button"
                  disabled={i === folders.length - 1 || reorderingFolders}
                  onClick={() => moveFolder(f, 1)}
                  title="Move down"
                >
                  ▼
                </button>
              </div>
              <div className="manage-row__body">
                <div className="manage-row__title">{f.name}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar-row" style={{ marginTop: 28 }}>
        <h2 className="settings-page__section-title">News Feeds</h2>
      </div>
      <p className="settings-page__section-hint">
        Add, rename, re-folder, or remove the RSS feeds that populate the News page. Folders group feeds in News'
        sidebar — type an existing one or a new name.
      </p>

      <div className="news-feeds-modal">
        <div className="news-feeds-modal__add">
          <input
            className="news-feeds-modal__url-input"
            placeholder="Feed URL (https://example.com/feed.xml)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFeed()}
          />
          <input
            className="news-feeds-modal__folder-input"
            placeholder="Folder (optional)"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            list="news-existing-folders"
            onKeyDown={(e) => e.key === 'Enter' && addFeed()}
          />
          <datalist id="news-existing-folders">
            {existingFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <button className="btn btn--sm" onClick={addFeed} disabled={adding || !url.trim()}>
            {adding ? 'Adding…' : 'Add Feed'}
          </button>
        </div>
        {addError && <p className="news-feeds-modal__error">{addError}</p>}

        <div className="news-feeds-modal__list">
          {feeds.length === 0 && <p className="news-page__empty-hint">No feeds yet.</p>}
          {feeds.map((f) => {
            const draft = editing[f.id];
            return (
              <div key={f.id} className="news-feeds-modal__row">
                {draft ? (
                  <>
                    <input
                      className="news-feeds-modal__row-input"
                      value={draft.title}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [f.id]: { ...ed[f.id], title: e.target.value } }))}
                    />
                    <input
                      className="news-feeds-modal__row-input news-feeds-modal__row-input--folder"
                      value={draft.folder}
                      placeholder="Folder"
                      list="news-existing-folders"
                      onChange={(e) => setEditing((ed) => ({ ...ed, [f.id]: { ...ed[f.id], folder: e.target.value } }))}
                    />
                    <button className="btn btn--sm" onClick={() => saveEdit(f)}>
                      Save
                    </button>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() =>
                        setEditing((e) => {
                          const n = { ...e };
                          delete n[f.id];
                          return n;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <div className="news-feeds-modal__row-info">
                      <div className="news-feeds-modal__row-title">
                        {f.last_fetch_error && <span className="news-page__feed-error-dot" title={f.last_fetch_error} />}
                        {f.title}
                      </div>
                      <div className="news-feeds-modal__row-sub">
                        {f.folder ?? 'Uncategorized'} · {f.url}
                      </div>
                    </div>
                    <button className="btn btn--sm btn--ghost" onClick={() => startEdit(f)}>
                      Edit
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => setConfirmDelete(f)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Remove feed?"
          body={`This removes "${confirmDelete.title}" and its cached articles. Anything you've saved from it stays in Saved.`}
          confirmLabel="Remove"
          onConfirm={() => deleteFeed(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
